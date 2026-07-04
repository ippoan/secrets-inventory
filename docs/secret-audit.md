# Secret 棚卸 (secret-audit) — 設計 + runbook

Refs #86。月次で GCP Secret Manager (SoT) の全 secret を分類し、退役 secret を
scream test 経由で安全に destroy するための仕組み。実装は
[`scripts/secret-audit/audit.py`](../scripts/secret-audit/audit.py) と
[`.github/workflows/secret-audit.yml`](../.github/workflows/secret-audit.yml)。

## なぜ v2 (YAML 参照 × run 実績) なのか

2026-07-04 の手動棚卸で判明した事実:

- 従来の「Cloud Run 未参照」判定 (secretKeyRef 走査のみ) は 57 件中約 40 件が誤検知。
  GH Actions org secret の SoT / CF Secrets Store の SoT / runtime
  AccessSecretVersion (`*_SECRET_NAME` 型 env 間接参照) を全部「未使用」と誤判定していた
- `used-by-*` ラベルには 2 つの穴があった:
  1. **誤 `removed`** — `NUXT_EGOV_CLIENT_SECRET` はラベル `removed` だが現役だった
  2. **無ラベル** — ラベル付与は wrangler `secrets.required` を持つ repo の CI 経由
     (secret-verify) のため、GH Actions 消費クラス (`CI_APP_*`, `KAGOYA_VPS_*`,
     `HCREADER_RELEASE_*` 等 ~20 件) は適用範囲外だった
- GitHub は secret の **read イベントを一切出さない** (org audit log は
  create/update/remove のみ、API は Enterprise 限定)。よって GH 側の last-used は
  「workflow YAML の `secrets.<NAME>` 参照 × 直近 90 日の run 実績 (Actions API)」で
  合成するのが上限であり、これで十分実用になる

per-repo CI で GH クラスを刻印する案は不採用:
(a) WIF pool の attribute_condition が `repository_owner == 'ippoan'` のため
ohishi-exp repo から刻印経路が無い、(b) `secrets: inherit` で reusable 側だけが
参照する secret (例: auto-merge.yml の `CI_APP_ID`) が caller YAML に現れない、
(c) 55 repo への配線コスト。→ **本 repo の月次 workflow が中央スキャナとして刻印**する。

## 分類 (バケット) と判定順

| # | bucket | 条件 | 扱い |
|---|---|---|---|
| 1 | `quarantined` | `pending-destroy` ラベルあり | 30 日経過で destroy 対象 |
| 2 | `keep` | `keep=always` ラベル | 監査対象外 (署名鍵・keystore 等) |
| 3 | `gcp-runtime` | Cloud Run/Jobs の secretKeyRef、または plain env 値が secret 名を指す (runtime read) | 現役 |
| 4 | `gh-active` | workflow YAML が参照 & その workflow が 90 日以内に run | 現役。`used-by-gh-*=active-YYYYMM` 刻印 |
| 5 | `gh-dormant` | YAML 参照はあるが 90 日 run 実績なし | **要確認** (休眠 repo)。`dormant-YYYYMM` 刻印 |
| 6 | `cf-backup` | 非 `used-by-gh-` の `used-by-*=active` ラベル (per-repo CI 刻印 = CF クラス) | 現役 SoT backup |
| 7 | `mirror-orphan` | GH org / CF Store にミラーはあるが consumer 宣言ゼロ | **要確認** (ミラーごと退役候補) |
| 8 | `candidate` | 全シグナル無し | **削除候補** |

- CF Store 突合は proxy `/cf/secrets` 経由 (`X-Inventory-API-Key` は Secret Manager
  から accessVersion、プロセスメモリ内のみ)。proxy 未達時は「不明」扱いで、
  candidate 判定に注記が付く (get_drift と同じ「不明をどちらにも倒さない」規約)
- GH 名 ↔ GCP 名の突合は exact → kebab⇔SNAKE 正規化 → `aliases.json` の順。
  exact がある時は正規化 match しない (SNAKE/kebab 両方が GCP に居るケースで
  片方に誤マッチしないため)

## ラベル規約 (本スキャナが増やすもの)

| ラベル | 値 | 書き手 |
|---|---|---|
| `used-by-gh-<org>-<repo>` | `active-YYYYMM` / `dormant-YYYYMM` / `removed` | 本スキャナ (毎月再生成 = 腐らない) |
| `pending-destroy` | `YYYYMMDD` (隔離開始日) | quarantine mode |
| `keep=always` | 固定 | operator 手動 (下記 one-time) |

スキャナは自分の prefix `used-by-gh-` のラベル**だけ**を書き換える。
CF クラスの `used-by-<repo>` (secret-verify 刻印) には触れない。

## 削除フロー (scream test)

```
月次レポート issue で candidate / mirror-orphan / gh-dormant を精査
  ↓ operator 判断
Actions → Secret Audit → Run workflow
  mode=quarantine, secrets=a,b,c, confirm=QUARANTINE
  → 全 ENABLED version を disable + pending-destroy=YYYYMMDD
  → 実は使われていた場合、consumer が loud fail する
    (gcloud secrets versions enable で即復旧)
  ↓ 30 日
  mode=destroy, confirm=DESTROY
  → 隔離 30 日経過 & 全 version disabled のものだけ destroy
  → default は名前+ラベルを tombstone として残置 (課金は version 単位なので $0)
    delete_names=true で名前ごと削除
```

ガード: `keep=always` と Cloud Run 参照中の secret は quarantine を拒否する。
隔離中に誰かが re-enable した secret は destroy を skip する (= scream 検知)。

## One-time setup (operator)

### 1. App 権限 (済)

`ippoan-ci-bot` に Repository permissions → **Actions: Read** (2026-07-04 付与済)。
既存の Contents: Read / Organization Secrets: Read/Write はそのまま使う。
両 org の installation で権限更新を承認すること。

### 2. quarantine / destroy 用 custom role

report mode は staging-deploy SA の既存 grant (`secretmanager.viewer` +
`secretsInventoryLabeler` + `secretAccessor`) だけで動く。
quarantine / destroy には version の disable/enable/destroy 権限が必要:

```bash
PROJECT=cloudsql-sv

gcloud iam roles create secretsInventoryAuditor \
  --project=$PROJECT \
  --title="Secrets Inventory Auditor" \
  --description="Disable/enable/destroy secret versions and delete secrets for the audited quarantine flow (no value read)" \
  --permissions=secretmanager.versions.disable,secretmanager.versions.enable,secretmanager.versions.destroy,secretmanager.secrets.delete \
  --stage=GA

gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:staging-deploy@cloudsql-sv.iam.gserviceaccount.com" \
  --role="projects/$PROJECT/roles/secretsInventoryAuditor"
```

`secretAccessor` (値 read) は含まれない。grant 前に quarantine/destroy を叩くと
403 で loud fail する (report は影響なし)。

### 3. destroy 猶予 (推奨)

全 secret に destroy の 7 日取り消し猶予を付ける (誤爆保険):

```bash
gcloud secrets list --project=cloudsql-sv --format='value(name)' | while read -r S; do
  gcloud secrets update "$S" --project=cloudsql-sv --version-destroy-ttl=7d
done
```

### 4. `keep=always` の手動付与

自動 declaration source が無い手動運用クラス、および誤検知を恒久停止したい
署名鍵類に付与する:

```bash
for S in HCREADER_RELEASE_KEYSTORE_BASE64 MINISIGN_SECRET_KEY GMAIL_APP_PASSWORD; do
  gcloud secrets update "$S" --project=cloudsql-sv --update-labels=keep=always
done
```

(`HCREADER_RELEASE_*` / `CI_APP_*` / `KAGOYA_VPS_*` 等の GH Actions クラスは
スキャナが `used-by-gh-*=active-*` を刻印するので keep=always は不要。
付けるのは「どのシグナルにも出ないが消してはいけない」ものだけ。)

## 制約 / 既知の限界

- `if:` で skip される step/job 内の secret 参照も「使用」側に倒れる (誤削除しない方向)
- reusable workflow の展開は 1 段のみ (現状 reusable は ci-workflows にほぼ集約されて
  いるため十分。多段 nest を導入したらここを拡張する)
- repo-level Actions secret の**存在**は列挙しない (App の repo Secrets read に依存
  しないため)。参照側 (YAML) の走査でカバーされる
- VPS の `.env` 等、GitHub/CF/GCP のどこにも consumer 宣言が無いものは検出不能 →
  `keep=always` を手で付ける
- v3 候補: Secret Manager の DATA_READ 監査ログ (`AccessSecretVersion`) を有効化し、
  gcp-runtime クラスの「宣言はあるが実 read なし」を検出する (現状は未有効化)

## コスト文脈

棚卸の動機は保管コスト (2026-07 時点: 95 versions × $0.06 ≈ ¥855/月、目標 ¥500)。
version 単価課金なので、削減レバーは「version の destroy」だけ。disable では
課金が止まらない点に注意 (それでも scream test の 30 日 ≈ ¥9/件は保険として払う)。
