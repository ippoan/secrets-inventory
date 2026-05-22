import type { SaInventoryResult, SaInventoryRow } from "./sa-inventory";
import type { SaFlag, SaStatus } from "./audit/sa-flags";
import { escapeHtml, escapeAttr } from "./ui";
import { gcpConsoleListUrl } from "./gcp-console";

const STATUS_LABEL: Record<SaStatus, string> = {
  ok: "🟢 ok",
  warn: "🟡 warn",
  candidate: "🔴 候補",
};

const FLAG_LABEL: Record<SaFlag, string> = {
  "no-role": "no-role",
  disabled: "disabled",
  "key-old": "key-old",
  "default-sa": "default-sa",
  "key-anomaly": "key-anomaly",
  "stale-auth": "stale-auth",
  "has-user-key": "has-user-key",
};

const FLAG_TOOLTIP: Record<SaFlag, string> = {
  "no-role": "project IAM policy に role binding が 1 件もない",
  disabled: "SA が disabled 状態 (削除候補)",
  "key-old": "user-managed key の最古 valid_after が 180 日超",
  "default-sa": "GCE / App Engine の自動生成 default SA。削除すると依存サービスが壊れるため削除不可。editor role 等の過剰権限の縮小のみ可。",
  "key-anomaly": "user-managed key 数 ≥ 3 (rotation 中以外で多すぎ)",
  "stale-auth": "Policy Analyzer が観測した最終認証が 90 日超過 (= 真に未使用の可能性)",
  "has-user-key": "USER_MANAGED key を 1 個以上保持 = WIF / ADC へキーレス移行候補",
};

export interface RenderSaInventoryOptions {
  /** 表示時の status filter。指定すると該当 status のみ table に出す。 */
  filter?: SaStatus;
}

export function renderSaInventoryPage(
  result: SaInventoryResult,
  opts: RenderSaInventoryOptions = {},
): string {
  const projectId = result.gcp_project_id;
  const rows = opts.filter
    ? result.rows.filter((r) => r.audit.status === opts.filter)
    : result.rows;

  const summaryHtml = renderSummary(result, opts.filter);
  const rowsHtml = rows.map((r) => renderRow(r, projectId)).join("");

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SA Inventory — ${escapeHtml(projectId)}</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <header>
    <h1>🛠 GCP Service Account Inventory</h1>
    <p class="sub">
      GCP project
      <a class="name-link" href="${escapeAttr(gcpConsoleListUrl(projectId))}" target="_blank" rel="noopener">
        ${escapeHtml(projectId)}
      </a>
      の SA を 5 シグナルで監査します。
      <a class="back" href="/">← Secrets Inventory に戻る</a>
      <a class="json-link" href="?format=json" title="同 inventory を JSON で取得 (/api/service-accounts と同 shape)">JSON</a>
    </p>
  </header>

  ${summaryHtml}

  <table>
    <thead>
      <tr>
        <th>status</th>
        <th>email</th>
        <th>flags</th>
        <th>roles</th>
        <th>user keys</th>
        <th>最古 key</th>
        <th>最終認証</th>
        <th>fetched</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml || `<tr><td colspan="8" class="muted">該当 SA なし</td></tr>`}
    </tbody>
  </table>

  <footer>
    <p class="muted">
      fetched at <time>${escapeHtml(result.fetched_at)}</time> /
      5 シグナル定義は
      <a href="https://github.com/ippoan/secrets-inventory/issues/20" target="_blank" rel="noopener">issue #20</a>
      を参照
    </p>
  </footer>
</body>
</html>`;
}

function renderSummary(
  result: SaInventoryResult,
  filter: SaStatus | undefined,
): string {
  const { total, ok, warn, candidate } = result.summary;
  return `<section class="summary">
    <div class="summary-item">
      <strong>Total</strong>: ${total}
    </div>
    <div class="summary-item ${filter === "candidate" ? "active" : ""}">
      <a href="?status=candidate"><strong>🔴 候補</strong>: ${candidate}</a>
    </div>
    <div class="summary-item ${filter === "warn" ? "active" : ""}">
      <a href="?status=warn"><strong>🟡 warn</strong>: ${warn}</a>
    </div>
    <div class="summary-item ${filter === "ok" ? "active" : ""}">
      <a href="?status=ok"><strong>🟢 ok</strong>: ${ok}</a>
    </div>
    <div class="summary-item ${!filter ? "active" : ""}">
      <a href="/service-accounts"><strong>すべて</strong></a>
    </div>
  </section>`;
}

/**
 * GCP が自動生成し、project の生存期間中は削除しても再生成される / 削除すると
 * 依存サービス (Cloud Run / App Engine / Cloud Build) が壊れる default SA か。
 * email の suffix で判定する。
 *
 * - `*@appspot.gserviceaccount.com` … App Engine default SA
 * - `*@developer.gserviceaccount.com` … Compute Engine default SA (project number prefix)
 */
export function isUndeletableDefaultSa(email: string): boolean {
  return (
    email.endsWith("@appspot.gserviceaccount.com") ||
    email.endsWith("@developer.gserviceaccount.com")
  );
}

function renderRow(row: SaInventoryRow, projectId: string): string {
  const { sa, audit } = row;
  const undeletable = isUndeletableDefaultSa(sa.email);
  const flagsHtml = audit.flags
    .map(
      (f) =>
        `<span class="flag" title="${escapeAttr(FLAG_TOOLTIP[f])}">${escapeHtml(FLAG_LABEL[f])}</span>`,
    )
    .join(" ");
  const rolesHtml = renderRoles(sa.roles);
  const oldestKey =
    audit.oldest_user_key_age_days === null
      ? `<span class="muted">—</span>`
      : `<span class="${audit.flags.includes("key-old") ? "warn" : ""}">${audit.oldest_user_key_age_days} 日</span>`;
  const lastAuthHtml = renderLastAuth(sa.last_authenticated_at);

  const tooltipParts: string[] = [];
  if (sa.display_name) tooltipParts.push(`name: ${sa.display_name}`);
  if (sa.description) tooltipParts.push(`desc: ${sa.description}`);
  if (sa.unique_id) tooltipParts.push(`uid: ${sa.unique_id}`);
  const emailTooltip = tooltipParts.join(" / ");

  const undeletableBadge = undeletable
    ? ` <span class="badge-locked" title="GCP の自動生成 default SA。削除すると依存サービスが壊れるため削除不可。">🔒 削除不可</span>`
    : "";

  return `<tr class="status-${audit.status}${undeletable ? " undeletable" : ""}">
    <td>${STATUS_LABEL[audit.status]}</td>
    <td>
      <a class="name-link" href="${escapeAttr(saConsoleUrl(projectId, sa.email))}" target="_blank" rel="noopener" title="${escapeAttr(emailTooltip)}">
        ${escapeHtml(sa.email)}
      </a>${undeletableBadge}
    </td>
    <td>${flagsHtml || `<span class="muted">—</span>`}</td>
    <td>${rolesHtml}</td>
    <td>${audit.user_managed_key_count}</td>
    <td class="ts">${oldestKey}</td>
    <td class="ts">${lastAuthHtml}</td>
    <td class="muted">${sa.disabled ? "disabled" : ""}</td>
  </tr>`;
}

/**
 * 最終認証時刻を "N 日前" 表示で返す。`undefined` (proxy が空文字を返した、
 * Policy Analyzer 未付与、観測期間中認証なし) は "—" + tooltip で説明、
 * >90 日は `warn` クラスで強調。
 *
 * `now()` ではなく `Date.now()` を直接呼ぶ test がぶつかると flaky になるが、
 * 単位が日なので 1 ms の誤差で不安定にはならない。
 */
export function renderLastAuth(rfc3339: string | undefined): string {
  if (!rfc3339) {
    return `<span class="muted" title="Policy Analyzer の観測期間中に認証無し / API 未有効 / 権限不足">—</span>`;
  }
  const ts = Date.parse(rfc3339);
  if (Number.isNaN(ts)) {
    return `<span class="muted" title="${escapeAttr(rfc3339)}">?</span>`;
  }
  const days = Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24));
  if (days < 0) {
    // 将来の timestamp (clock drift / API バグ) は そのまま 0 日前表示。
    return `<span title="${escapeAttr(rfc3339)}">0 日前</span>`;
  }
  const cls = days > 90 ? "warn" : "";
  return `<span class="${cls}" title="${escapeAttr(rfc3339)}">${days} 日前</span>`;
}

function renderRoles(roles: string[]): string {
  if (roles.length === 0) return `<span class="muted">なし</span>`;
  const head = roles.slice(0, 3);
  const rest = roles.length - head.length;
  const chips = head
    .map(
      (r) =>
        `<span class="role" title="${escapeAttr(r)}">${escapeHtml(shortRole(r))}</span>`,
    )
    .join(" ");
  if (rest > 0) {
    return `${chips} <span class="role more" title="${escapeAttr(roles.slice(3).join("\n"))}">+${rest}</span>`;
  }
  return chips;
}

function shortRole(role: string): string {
  // roles/secretmanager.viewer → secretmanager.viewer
  return role.startsWith("roles/") ? role.slice("roles/".length) : role;
}

function saConsoleUrl(projectId: string, saEmail: string): string {
  return `https://console.cloud.google.com/iam-admin/serviceaccounts/details/${encodeURIComponent(saEmail)}?project=${encodeURIComponent(projectId)}`;
}

const PAGE_STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  margin: 0;
  padding: 1.5rem;
  max-width: 1200px;
}
header h1 { margin: 0 0 .25rem; font-size: 1.3rem; }
.sub { margin: 0 0 1rem; color: #666; }
.back { margin-left: 1rem; font-size: .85rem; }
.json-link {
  margin-left: .5rem;
  font-size: .75rem;
  padding: .1rem .4rem;
  border: 1px solid currentColor;
  border-radius: 3px;
  text-decoration: none;
  opacity: .7;
}
.json-link:hover { opacity: 1; }
.name-link { color: inherit; text-decoration: underline dotted; }
.muted { color: #888; }
.summary {
  display: flex;
  gap: 1rem;
  padding: .75rem 1rem;
  background: rgba(0,0,0,0.04);
  border-radius: 6px;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}
.summary-item a { color: inherit; text-decoration: none; }
.summary-item.active { font-weight: bold; }
table {
  width: 100%;
  border-collapse: collapse;
  font-size: .9rem;
}
th, td {
  text-align: left;
  padding: .4rem .6rem;
  border-bottom: 1px solid rgba(0,0,0,0.1);
  vertical-align: top;
}
th { background: rgba(0,0,0,0.03); font-weight: 600; }
tr.status-candidate { background: rgba(220,53,69,0.06); }
tr.status-warn { background: rgba(255,193,7,0.06); }
.flag {
  display: inline-block;
  padding: 1px 6px;
  margin: 1px 1px;
  background: rgba(220,53,69,0.15);
  color: #a02029;
  border-radius: 3px;
  font-size: .75rem;
  font-family: monospace;
}
.role {
  display: inline-block;
  padding: 1px 6px;
  margin: 1px 1px;
  background: rgba(13,110,253,0.1);
  color: #084298;
  border-radius: 3px;
  font-size: .72rem;
  font-family: monospace;
}
.role.more { background: rgba(0,0,0,0.08); color: #555; cursor: help; }
.badge-locked {
  display: inline-block;
  padding: 1px 6px;
  margin-left: .35rem;
  background: rgba(0,0,0,0.08);
  color: #555;
  border-radius: 3px;
  font-size: .7rem;
  font-family: monospace;
  white-space: nowrap;
  cursor: help;
}
.ts { font-family: monospace; font-size: .8rem; white-space: nowrap; }
.ts .warn { color: #a06800; font-weight: 600; }
footer { margin-top: 2rem; font-size: .8rem; }
`;
