#!/usr/bin/env python3
"""GCP Secret Manager 棚卸 (v2) — Refs #86

判定シグナル:
  1. Cloud Run/Jobs の secretKeyRef + plain env 値が secret 名を指す間接参照
     (例: `CF_TOKEN_SECRET_NAME=cf-secrets-inventory-secrets-store-write`)
  2. GitHub Actions: workflow YAML の `secrets.<NAME>` 参照 (reusable workflow
     1 段展開込み) × 直近 90 日の run 実績。GitHub は secret の read イベントを
     一切出さない (audit log は create/update/remove のみ) ため、
     「参照 × 実行実績」で実質 last-used を合成する。
  3. ラベル: keep=always (監査対象外) / used-by-* (CF クラス、per-repo CI が刻印) /
     used-by-gh-* (本スキャナが刻印・管理する導出ラベル) / pending-destroy (隔離中)
  4. 3-provider 突合: GitHub org secrets / CF Secrets Store (proxy /cf/secrets)

modes:
  report     スキャン + used-by-gh-* ラベル刻印 + レポート issue 起票
  quarantine 指定 secret の versions disable + pending-destroy ラベル (scream test)
  destroy    隔離 30 日経過 & 全 version disabled の secret を destroy

secret の値は proxy API key (accessVersion 1 件、プロセスメモリ内のみ) を除き
一切読まない。レポート / ログにも値は出ない。
"""

from __future__ import annotations

import argparse
import base64
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

GCP_PROJECT = os.environ.get("GCP_PROJECT_ID", "cloudsql-sv")
GCP_REGION = os.environ.get("GCP_REGION", "asia-northeast1")
PROXY_URL = os.environ.get(
    "PROXY_URL", "https://secrets-inventory-gcp-staging-566bls5vfq-an.a.run.app"
)
PROXY_KEY_SECRET = os.environ.get(
    "PROXY_KEY_SECRET", "SECRETS_INVENTORY_GCP_PROXY_API_KEY_STAGING"
)
ORGS = [
    ("ippoan", "GH_TOKEN_IPPOAN"),
    ("ohishi-exp", "GH_TOKEN_OHISHI"),
]
RUN_WINDOW_DAYS = 90
QUARANTINE_DAYS = 30
COST_PER_VERSION_USD = 0.06
MANAGED_PREFIX = "used-by-gh-"  # 本スキャナが所有するラベル prefix
SM_BASE = "https://secretmanager.googleapis.com/v1"
RUN_BASE = "https://run.googleapis.com/v2"
GH_BASE = "https://api.github.com"

JST = datetime.timezone(datetime.timedelta(hours=9))

# `${{ secrets.NAME }}` 参照。GITHUB_TOKEN は runner 供給なので除外。
SECRET_REF_RE = re.compile(r"\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_-]*)")
REF_EXCLUDE = {"GITHUB_TOKEN", "github_token"}
# reusable workflow 呼び出し (`uses: owner/repo/.github/workflows/x.yml@ref`)
REUSABLE_RE = re.compile(
    r"uses:\s*[\"']?([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)"
    r"/(\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml)@([A-Za-z0-9_./-]+)"
)


# ---------------------------------------------------------------- pure helpers


def norm_name(name: str) -> str:
    """kebab/SNAKE 差を吸収する正規化 (CAP_CATALOG_R2_TOKEN ↔ cap-catalog-r2-token)."""
    return name.lower().replace("_", "-")


def extract_secret_refs(yaml_text: str) -> set[str]:
    return {m for m in SECRET_REF_RE.findall(yaml_text) if m not in REF_EXCLUDE}


def extract_reusable_uses(yaml_text: str) -> set[tuple[str, str, str, str]]:
    return set(REUSABLE_RE.findall(yaml_text))


def build_ref_index(gcp_names: set[str], aliases: dict[str, list[str]]):
    """GH 側の secret 名 → GCP secret 名集合の解決材料を作る。

    exact match が最優先。exact が無い時だけ正規化 match に落ちる
    (RELEASE_WAVE_WEBHOOK_SECRET が SNAKE/kebab の両 GCP secret に
    誤って両方マッチしないための規則)。alias は常に追加適用。
    """
    by_norm: dict[str, set[str]] = {}
    for g in gcp_names:
        by_norm.setdefault(norm_name(g), set()).add(g)
    rev_alias: dict[str, set[str]] = {}
    for gcp, ghs in aliases.items():
        if gcp not in gcp_names:
            continue
        for gh in ghs:
            rev_alias.setdefault(gh, set()).add(gcp)
    return by_norm, rev_alias


def resolve_ref(
    gh_name: str,
    gcp_names: set[str],
    by_norm: dict[str, set[str]],
    rev_alias: dict[str, set[str]],
) -> set[str]:
    out: set[str] = set()
    if gh_name in gcp_names:
        out.add(gh_name)
    else:
        out |= by_norm.get(norm_name(gh_name), set())
    out |= rev_alias.get(gh_name, set())
    return out


def sanitize_label_key(org: str, repo: str) -> str:
    key = f"{MANAGED_PREFIX}{org}-{repo}".lower()
    key = re.sub(r"[^a-z0-9_-]", "-", key)
    return key[:63]


def classify(info: dict) -> tuple[str, list[str]]:
    """1 secret 分のシグナルからバケットと根拠を返す。

    info keys: labels(dict), cloud_run_direct(bool), cloud_run_indirect(bool),
    gh_refs(list[{org,repo,workflow,ran_recent}]), in_gh_org(bool),
    in_cf(bool|None)  # None = CF 突合不能 (proxy 未達)
    """
    labels = info.get("labels") or {}
    ev: list[str] = []
    if "pending-destroy" in labels:
        return "quarantined", [f"pending-destroy={labels['pending-destroy']}"]
    if labels.get("keep") == "always":
        return "keep", ["keep=always"]
    if info.get("cloud_run_direct"):
        return "gcp-runtime", ["Cloud Run/Jobs secretKeyRef"]
    if info.get("cloud_run_indirect"):
        return "gcp-runtime", ["Cloud Run env が secret 名を指す (runtime read)"]
    gh_refs = info.get("gh_refs") or []
    active = [r for r in gh_refs if r.get("ran_recent")]
    if active:
        ev = [f"{r['org']}/{r['repo']}:{r['workflow']}" for r in active[:5]]
        return "gh-active", ev
    if gh_refs:
        ev = [f"{r['org']}/{r['repo']}:{r['workflow']} (run 実績なし)" for r in gh_refs[:5]]
        return "gh-dormant", ev
    cf_active = [
        k
        for k, v in labels.items()
        if k.startswith("used-by-")
        and not k.startswith(MANAGED_PREFIX)
        and str(v).startswith("active")
    ]
    if cf_active:
        return "cf-backup", cf_active[:5]
    in_cf = info.get("in_cf")
    if in_cf or info.get("in_gh_org"):
        where = [p for p, x in (("cf", in_cf), ("gh-org", info.get("in_gh_org"))) if x]
        return "mirror-orphan", [f"ミラー存在 ({','.join(where)}) だが consumer 宣言なし"]
    if in_cf is None:
        return "candidate", ["全シグナル無し (※CF 突合不能、proxy 未達)"]
    return "candidate", ["全シグナル無し"]


def plan_label_updates(existing: dict, desired_managed: dict) -> dict | None:
    """used-by-gh-* prefix のラベルだけを管理する merge 案を返す。変更無しなら None。

    - 非 managed ラベル (CF クラスの used-by-* / keep 等) には触れない
    - 以前 managed だったが今回参照が消えた key は value=removed で残す
    """
    new = {k: v for k, v in existing.items() if not k.startswith(MANAGED_PREFIX)}
    for k in existing:
        if k.startswith(MANAGED_PREFIX) and k not in desired_managed:
            new[k] = "removed"
    new.update(desired_managed)
    if len(new) > 64:
        # GCP のラベル上限。managed の removed を優先的に間引く
        for k in sorted([k for k, v in new.items() if v == "removed"]):
            if len(new) <= 64:
                break
            del new[k]
    return None if new == existing else new


def destroy_due(pending_value: str, today: datetime.date) -> bool:
    """pending-destroy=YYYYMMDD が QUARANTINE_DAYS 経過したか。不正値は False。"""
    try:
        stamped = datetime.datetime.strptime(pending_value, "%Y%m%d").date()
    except ValueError:
        return False
    return (today - stamped).days >= QUARANTINE_DAYS


# ------------------------------------------------------------------- HTTP 層


def _request(method: str, url: str, token: str | None, body=None, headers=None,
             raw: bool = False, tolerate: tuple[int, ...] = ()):
    h = {"User-Agent": "secrets-inventory-audit"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    if headers:
        h.update(headers)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = resp.read()
    except urllib.error.HTTPError as e:
        if e.code in tolerate:
            return None
        detail = e.read()[:300].decode(errors="replace")
        raise RuntimeError(f"{method} {url} -> {e.code}: {detail}") from None
    if raw:
        return payload.decode(errors="replace")
    return json.loads(payload) if payload else {}


def gh_get(token: str, path: str, params: dict | None = None, raw: bool = False,
           tolerate: tuple[int, ...] = ()):
    url = f"{GH_BASE}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = {"X-GitHub-Api-Version": "2022-11-28"}
    headers["Accept"] = "application/vnd.github.raw+json" if raw else "application/vnd.github+json"
    return _request("GET", url, token, headers=headers, raw=raw, tolerate=tolerate)


def gh_paginate(token: str, path: str, key: str | None, params: dict | None = None):
    out = []
    page = 1
    while True:
        p = dict(params or {})
        p.update({"per_page": 100, "page": page})
        data = gh_get(token, path, p)
        items = data.get(key, []) if key else data
        out.extend(items)
        if len(items) < 100:
            return out
        page += 1


def sm_get(gcp_token: str, path: str, params: dict | None = None):
    url = f"{SM_BASE}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    return _request("GET", url, gcp_token)


# ----------------------------------------------------------------- スキャン


def fetch_gcp_secrets(gcp_token: str) -> dict[str, dict]:
    secrets: dict[str, dict] = {}
    token = None
    while True:
        params = {"pageSize": 300}
        if token:
            params["pageToken"] = token
        data = sm_get(gcp_token, f"projects/{GCP_PROJECT}/secrets", params)
        for s in data.get("secrets", []):
            name = s["name"].split("/")[-1]
            secrets[name] = {
                "labels": s.get("labels", {}),
                "create_time": s.get("createTime", ""),
            }
        token = data.get("nextPageToken")
        if not token:
            return secrets


def fetch_versions(gcp_token: str, name: str) -> list[dict]:
    data = sm_get(
        gcp_token,
        f"projects/{GCP_PROJECT}/secrets/{name}/versions",
        {"pageSize": 300},
    )
    return [
        {"id": v["name"].split("/")[-1], "state": v.get("state", "")}
        for v in data.get("versions", [])
    ]


def fetch_cloud_run_refs(gcp_token: str, gcp_names: set[str]) -> tuple[set[str], set[str]]:
    """(secretKeyRef/volume 直接参照, plain env 値による間接参照) を返す。"""
    direct: set[str] = set()
    env_values: set[str] = set()

    def eat_containers(containers, volumes):
        for c in containers or []:
            for e in c.get("env", []):
                ref = (e.get("valueSource") or {}).get("secretKeyRef") or {}
                if ref.get("secret"):
                    direct.add(ref["secret"].split("/")[-1])
                if isinstance(e.get("value"), str):
                    env_values.add(e["value"])
        for v in volumes or []:
            sec = (v.get("secret") or {}).get("secret")
            if sec:
                direct.add(sec.split("/")[-1])

    loc = f"projects/{GCP_PROJECT}/locations/{GCP_REGION}"
    svcs = _request("GET", f"{RUN_BASE}/{loc}/services?pageSize=200", gcp_token) or {}
    for s in svcs.get("services", []):
        tpl = s.get("template", {})
        eat_containers(tpl.get("containers"), tpl.get("volumes"))
    jobs = _request("GET", f"{RUN_BASE}/{loc}/jobs?pageSize=200", gcp_token) or {}
    for j in jobs.get("jobs", []):
        tpl = (j.get("template", {}) or {}).get("template", {})
        eat_containers(tpl.get("containers"), tpl.get("volumes"))
    return direct, env_values & gcp_names


def fetch_cf_names(gcp_token: str) -> set[str] | None:
    """proxy /cf/secrets 経由で CF Secrets Store の名前一覧。失敗時 None (不明扱い)。"""
    try:
        data = sm_get(
            gcp_token,
            f"projects/{GCP_PROJECT}/secrets/{PROXY_KEY_SECRET}/versions/latest:access",
        )
        key = base64.b64decode(data["payload"]["data"]).decode()
        resp = _request(
            "GET", f"{PROXY_URL}/cf/secrets", None, headers={"X-Inventory-API-Key": key}
        )
    except Exception as e:  # noqa: BLE001 — 突合不能は「不明」に倒す (drift 規約と同じ)
        print(f"::warning::CF Secrets Store 突合不能: {type(e).__name__}", file=sys.stderr)
        return None
    names: set[str] = set()

    def walk(node):
        if isinstance(node, dict):
            if isinstance(node.get("name"), str) and ("id" in node or "created_at" in node or "status" in node):
                names.add(node["name"])
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(resp)
    return names


def fetch_gh_org_secret_names(tokens: dict[str, str]) -> set[str]:
    names: set[str] = set()
    for org, env_key in ORGS:
        token = tokens.get(env_key)
        if not token:
            continue
        try:
            for s in gh_paginate(token, f"/orgs/{org}/actions/secrets", "secrets"):
                names.add(s["name"])
        except RuntimeError as e:
            print(f"::warning::org secrets list 失敗 ({org}): {e}", file=sys.stderr)
    return names


def scan_github(tokens: dict[str, str]) -> tuple[list[dict], list[str]]:
    """全 repo の workflow を走査し [{org, repo, workflow, refs, ran_recent}] を返す。"""
    cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=RUN_WINDOW_DAYS)).strftime("%Y-%m-%d")
    results: list[dict] = []
    errors: list[str] = []
    reusable_cache: dict[tuple[str, str, str, str], set[str]] = {}

    def reusable_refs(owner: str, repo: str, path: str, ref: str) -> set[str]:
        key = (owner, repo, path, ref)
        if key in reusable_cache:
            return reusable_cache[key]
        token = None
        for org, env_key in ORGS:
            if owner == org:
                token = tokens.get(env_key)
        refs: set[str] = set()
        if token:
            try:
                text = gh_get(token, f"/repos/{owner}/{repo}/contents/{path}",
                              {"ref": ref}, raw=True, tolerate=(404,))
                if text:
                    refs = extract_secret_refs(text)
            except RuntimeError as e:
                errors.append(f"reusable {owner}/{repo}/{path}: {e}")
        reusable_cache[key] = refs
        return refs

    for org, env_key in ORGS:
        token = tokens.get(env_key)
        if not token:
            errors.append(f"{org}: token 無し (App install / secrets 確認)")
            continue
        try:
            repos = gh_paginate(token, "/installation/repositories", "repositories")
        except RuntimeError as e:
            errors.append(f"{org}: repo 列挙失敗: {e}")
            continue
        for r in repos:
            full = r["full_name"]
            repo = r["name"]
            try:
                files = gh_get(token, f"/repos/{full}/contents/.github/workflows",
                               tolerate=(404,)) or []
                wf_texts = {}
                for f in files:
                    if not f["name"].endswith((".yml", ".yaml")):
                        continue
                    text = gh_get(token, f"/repos/{full}/contents/{f['path']}",
                                  raw=True, tolerate=(404,))
                    if text:
                        wf_texts[f["path"]] = text
                if not wf_texts:
                    continue
                # 直近 90 日に走った workflow path の集合
                ran_paths: set[str] = set()
                wfs = gh_paginate(token, f"/repos/{full}/actions/workflows", "workflows")
                for wf in wfs:
                    path = wf.get("path", "")
                    if not path.startswith(".github/workflows/"):
                        continue
                    runs = gh_get(
                        token,
                        f"/repos/{full}/actions/workflows/{wf['id']}/runs",
                        {"per_page": 1, "created": f">{cutoff}"},
                        tolerate=(404,),
                    )
                    if runs and runs.get("total_count", 0) > 0:
                        ran_paths.add(path)
                for path, text in wf_texts.items():
                    refs = set(extract_secret_refs(text))
                    for owner2, repo2, rpath, rref in extract_reusable_uses(text):
                        refs |= reusable_refs(owner2, repo2, rpath, rref)
                    if refs:
                        results.append({
                            "org": org,
                            "repo": repo,
                            "workflow": path.rsplit("/", 1)[-1],
                            "refs": sorted(refs),
                            "ran_recent": path in ran_paths,
                        })
            except RuntimeError as e:
                errors.append(f"{full}: {e}")
    return results, errors


# ------------------------------------------------------------------- 書き込み


def patch_labels(gcp_token: str, name: str, labels: dict):
    url = f"{SM_BASE}/projects/{GCP_PROJECT}/secrets/{name}?updateMask=labels"
    _request("PATCH", url, gcp_token, body={"labels": labels})


def stamp_gh_labels(gcp_token: str, secrets: dict[str, dict],
                    gh_refs_by_secret: dict[str, list[dict]]) -> list[str]:
    yyyymm = datetime.datetime.now(JST).strftime("%Y%m")
    stamped: list[str] = []
    for name, meta in secrets.items():
        desired: dict[str, str] = {}
        for ref in gh_refs_by_secret.get(name, []):
            key = sanitize_label_key(ref["org"], ref["repo"])
            state = "active" if ref["ran_recent"] else "dormant"
            # 同一 repo で active と dormant が混在したら active を優先
            if desired.get(key, "").startswith("active"):
                continue
            desired[key] = f"{state}-{yyyymm}"
        new = plan_label_updates(meta["labels"], desired)
        if new is not None:
            patch_labels(gcp_token, name, new)
            meta["labels"] = new
            stamped.append(name)
    return stamped


# ------------------------------------------------------------------ レポート


BUCKET_ORDER = [
    ("candidate", "削除候補"),
    ("mirror-orphan", "要確認 (ミラーはあるが consumer 宣言なし)"),
    ("gh-dormant", "要確認 (GH 参照はあるが 90 日 run 実績なし)"),
    ("quarantined", "隔離中 (scream test)"),
    ("gh-active", "GH Actions 現役"),
    ("cf-backup", "CF Secrets Store backup (SoT)"),
    ("gcp-runtime", "GCP runtime 参照"),
    ("keep", "keep=always"),
]


def render_report(rows: list[dict], total_versions: int, errors: list[str],
                  stamped: list[str], cf_ok: bool) -> str:
    now = datetime.datetime.now(JST)
    cost = total_versions * COST_PER_VERSION_USD
    counts = {}
    for r in rows:
        counts[r["bucket"]] = counts.get(r["bucket"], 0) + 1
    out = [f"# Secret 棚卸レポート {now.strftime('%Y-%m')}", ""]
    out.append(f"- 実行: {now.strftime('%Y-%m-%d %H:%M JST')} / project `{GCP_PROJECT}`")
    out.append(f"- secrets: **{len(rows)}** / active+disabled versions: **{total_versions}**")
    out.append(f"- 月額見積: **${cost:.2f}** (≈ ¥{cost * 150:.0f}, $0.06/version)")
    out.append(f"- CF 突合: {'OK' if cf_ok else '**不能 (proxy 未達) — candidate 判定は保守的に読む**'}")
    out.append(f"- ラベル刻印 (used-by-gh-*): {len(stamped)} 件更新")
    out.append("")
    for bucket, title in BUCKET_ORDER:
        items = [r for r in rows if r["bucket"] == bucket]
        if not items:
            continue
        out.append(f"## {title} ({len(items)})")
        out.append("")
        collapse = bucket in ("gh-active", "cf-backup", "gcp-runtime", "keep")
        if collapse:
            out.append("<details><summary>展開</summary>")
            out.append("")
        out.append("| secret | versions | 根拠 |")
        out.append("|---|---|---|")
        for r in sorted(items, key=lambda x: x["name"]):
            out.append(f"| `{r['name']}` | {r['versions']} | {'; '.join(r['evidence'])[:180]} |")
        if collapse:
            out.append("")
            out.append("</details>")
        out.append("")
    multi = [r for r in rows if r["versions"] > 1]
    if multi:
        out.append(f"## 複数 version 保持 ({len(multi)})")
        out.append("")
        for r in multi:
            out.append(f"- `{r['name']}`: {r['versions']} versions (全 consumer :latest なら旧版 destroy 可)")
        out.append("")
    out.append("## 次のアクション")
    out.append("")
    out.append("1. 削除候補 / 要確認を精査し、隔離する secret を決める")
    out.append("2. Actions → Secret Audit → Run workflow → mode=`quarantine`,")
    out.append("   `secrets` に comma 区切りで指定, `confirm=QUARANTINE`")
    out.append(f"3. {QUARANTINE_DAYS} 日壊れなければ mode=`destroy`, `confirm=DESTROY` で破棄")
    out.append("")
    out.append("運用手順の詳細: `docs/secret-audit.md` (Refs #86)")
    if errors:
        out.append("")
        out.append(f"## スキャン警告 ({len(errors)})")
        out.append("")
        for e in errors[:20]:
            out.append(f"- {e}")
    return "\n".join(out) + "\n"


def post_issue(report: str):
    token = os.environ.get("GH_ISSUE_TOKEN")
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not token or not repo:
        print("::warning::GH_ISSUE_TOKEN / GITHUB_REPOSITORY 無し — issue 起票 skip", file=sys.stderr)
        return
    title_prefix = "Secret 棚卸レポート"
    now = datetime.datetime.now(JST)
    olds = [
        i for i in gh_paginate(token, f"/repos/{repo}/issues", None, {"state": "open"})
        if i.get("title", "").startswith(title_prefix) and "pull_request" not in i
    ]
    created = _request(
        "POST", f"{GH_BASE}/repos/{repo}/issues", token,
        body={"title": f"{title_prefix} {now.strftime('%Y-%m')}",
              "body": report + "\nRefs #86\n"},
        headers={"X-GitHub-Api-Version": "2022-11-28"},
    )
    for old in olds:
        n = old["number"]
        _request("POST", f"{GH_BASE}/repos/{repo}/issues/{n}/comments", token,
                 body={"body": f"新レポート #{created['number']} に置き換え (Refs #86)"})
        _request("PATCH", f"{GH_BASE}/repos/{repo}/issues/{n}", token,
                 body={"state": "closed"})
    print(f"issue created: {created.get('html_url')}")


# --------------------------------------------------------------------- modes


def mode_report(args) -> int:
    gcp_token = os.environ["GCP_ACCESS_TOKEN"]
    tokens = {k: os.environ.get(k, "") for _, k in ORGS}
    alias_path = os.path.join(os.path.dirname(__file__), "aliases.json")
    with open(alias_path, encoding="utf-8") as f:
        aliases = json.load(f)

    secrets = fetch_gcp_secrets(gcp_token)
    gcp_names = set(secrets)
    direct, indirect = fetch_cloud_run_refs(gcp_token, gcp_names)
    cf_names = fetch_cf_names(gcp_token)
    gh_org_names = fetch_gh_org_secret_names(tokens)
    wf_rows, errors = scan_github(tokens)

    by_norm, rev_alias = build_ref_index(gcp_names, aliases)
    gh_refs_by_secret: dict[str, list[dict]] = {}
    for row in wf_rows:
        for gh_name in row["refs"]:
            for gcp_name in resolve_ref(gh_name, gcp_names, by_norm, rev_alias):
                gh_refs_by_secret.setdefault(gcp_name, []).append({
                    "org": row["org"], "repo": row["repo"],
                    "workflow": row["workflow"], "ran_recent": row["ran_recent"],
                })

    stamped: list[str] = []
    if not args.no_stamp:
        stamped = stamp_gh_labels(gcp_token, secrets, gh_refs_by_secret)

    gh_norm = {norm_name(n) for n in gh_org_names}
    rows = []
    total_versions = 0
    for name, meta in sorted(secrets.items()):
        versions = fetch_versions(gcp_token, name)
        live = [v for v in versions if v["state"] in ("ENABLED", "DISABLED")]
        total_versions += len(live)
        bucket, evidence = classify({
            "labels": meta["labels"],
            "cloud_run_direct": name in direct,
            "cloud_run_indirect": name in indirect,
            "gh_refs": gh_refs_by_secret.get(name, []),
            "in_gh_org": name in gh_org_names or norm_name(name) in gh_norm,
            "in_cf": (name in cf_names) if cf_names is not None else None,
        })
        rows.append({"name": name, "bucket": bucket, "evidence": evidence,
                     "versions": len(live)})

    report = render_report(rows, total_versions, errors, stamped, cf_names is not None)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(report)
    print(json.dumps(
        {"secrets": len(rows), "versions": total_versions,
         "buckets": {b: sum(1 for r in rows if r["bucket"] == b) for b, _ in BUCKET_ORDER},
         "stamped": len(stamped), "warnings": len(errors)},
        ensure_ascii=False))
    if not args.no_issue:
        post_issue(report)
    return 0


def mode_quarantine(args) -> int:
    if args.confirm != "QUARANTINE":
        print("::error::confirm=QUARANTINE が必要 (type-to-confirm)", file=sys.stderr)
        return 1
    targets = [s.strip() for s in (args.secrets or "").split(",") if s.strip()]
    if not targets:
        print("::error::--secrets が空", file=sys.stderr)
        return 1
    gcp_token = os.environ["GCP_ACCESS_TOKEN"]
    secrets = fetch_gcp_secrets(gcp_token)
    direct, indirect = fetch_cloud_run_refs(gcp_token, set(secrets))
    today = datetime.datetime.now(JST).strftime("%Y%m%d")
    failed = False
    for name in targets:
        meta = secrets.get(name)
        if meta is None:
            print(f"::error::{name}: GCP に存在しない", file=sys.stderr)
            failed = True
            continue
        if meta["labels"].get("keep") == "always":
            print(f"::error::{name}: keep=always — 隔離拒否", file=sys.stderr)
            failed = True
            continue
        if name in direct or name in indirect:
            print(f"::error::{name}: Cloud Run が参照中 — 隔離拒否", file=sys.stderr)
            failed = True
            continue
        disabled = 0
        for v in fetch_versions(gcp_token, name):
            if v["state"] == "ENABLED":
                _request("POST",
                         f"{SM_BASE}/projects/{GCP_PROJECT}/secrets/{name}/versions/{v['id']}:disable",
                         gcp_token, body={})
                disabled += 1
        labels = dict(meta["labels"])
        labels["pending-destroy"] = today
        patch_labels(gcp_token, name, labels)
        print(f"{name}: {disabled} version(s) disabled, pending-destroy={today}")
    return 1 if failed else 0


def mode_destroy(args) -> int:
    if args.confirm != "DESTROY":
        print("::error::confirm=DESTROY が必要 (type-to-confirm)", file=sys.stderr)
        return 1
    gcp_token = os.environ["GCP_ACCESS_TOKEN"]
    secrets = fetch_gcp_secrets(gcp_token)
    today = datetime.datetime.now(JST).date()
    acted = 0
    for name, meta in sorted(secrets.items()):
        pending = meta["labels"].get("pending-destroy")
        if not pending:
            continue
        if not destroy_due(pending, today):
            print(f"{name}: 隔離 {QUARANTINE_DAYS} 日未満 (pending-destroy={pending}) — skip")
            continue
        versions = fetch_versions(gcp_token, name)
        if any(v["state"] == "ENABLED" for v in versions):
            print(f"::warning::{name}: ENABLED version あり (隔離後に re-enable された?) — skip")
            continue
        for v in versions:
            if v["state"] == "DISABLED":
                _request("POST",
                         f"{SM_BASE}/projects/{GCP_PROJECT}/secrets/{name}/versions/{v['id']}:destroy",
                         gcp_token, body={})
        if args.delete_names:
            _request("DELETE", f"{SM_BASE}/projects/{GCP_PROJECT}/secrets/{name}", gcp_token)
            print(f"{name}: versions destroyed + secret deleted")
        else:
            print(f"{name}: versions destroyed (名前とラベルは tombstone として残置)")
        acted += 1
    print(f"destroyed: {acted} secret(s)")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="mode", required=True)
    rp = sub.add_parser("report")
    rp.add_argument("--out", default="secret-audit-report.md")
    rp.add_argument("--no-stamp", action="store_true", help="used-by-gh-* ラベル刻印を skip")
    rp.add_argument("--no-issue", action="store_true", help="issue 起票を skip")
    qp = sub.add_parser("quarantine")
    qp.add_argument("--secrets", required=True, help="comma 区切り")
    qp.add_argument("--confirm", default="")
    dp = sub.add_parser("destroy")
    dp.add_argument("--confirm", default="")
    dp.add_argument("--delete-names", action="store_true",
                    help="destroy 後に secret 名ごと削除 (default: tombstone 残置)")
    args = p.parse_args(argv)
    return {"report": mode_report, "quarantine": mode_quarantine, "destroy": mode_destroy}[args.mode](args)


if __name__ == "__main__":
    sys.exit(main())
