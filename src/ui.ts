import type { InventoryResult } from "./inventory";
import type { InventoryRow } from "./diff";
import type { ServiceTokenRow, ServiceTokenStatus } from "./service-tokens";
import type { SecretMetadata } from "./types";
import { gcpConsoleListUrl, gcpConsoleSecretUrl } from "./gcp-console";

/**
 * Hono context から呼ぶ pure な HTML レンダラー。SSR の最小骨格 (1 ファイルに
 * 完結する自前テンプレ + inline CSS) で、外部 asset / JS は使わない。CF Access
 * 経由でのみアクセスされる前提なので JS による fetch も不要。
 */
export function renderInventoryPage(
  result: InventoryResult,
): string {
  const projectId = result.gcp_project_id;
  const errorBanners = renderErrorBanners(result.errors);

  const lastSnap = result.previous_snapshot_at
    ? `<time>${escapeHtml(result.previous_snapshot_at)}</time>`
    : `<em class="muted">none — まだ snapshot を撮っていません</em>`;

  const committedNote = result.snapshot_committed
    ? `<p class="hint">📸 snapshot を ${escapeHtml(result.snapshot_at ?? "")} で更新しました。</p>`
    : "";

  const diffSummary = renderDiffSummary(result.diff);

  // 列ヘッダーに「マッチ数 / 取得総数」を出すための集計。
  // - GCP は全行マッチ (= source of truth) なので分母を出さず数だけ
  // - GitHub / CF: 分子 = この GCP 一覧と名前突合できた数 (= in_X===true)
  //                分母 = provider 側の総取得数 (= provider_counts)
  // provider_counts が null = fetch 失敗で分母不明、ヘッダーは `(?)` 表記
  let ghMatch = 0;
  let cfMatch = 0;
  for (const r of result.rows) {
    if (r.in_github === true) ghMatch++;
    if (r.in_cloudflare === true) cfMatch++;
  }

  const rowsHtml = result.rows
    .map((r) => renderRow(r, projectId))
    .join("");

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Secrets Inventory — ${escapeHtml(projectId)}</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <header>
    <h1>🔐 Secrets Inventory</h1>
    <p class="sub">
      GCP project
      <a class="name-link" href="${escapeAttr(gcpConsoleListUrl(projectId))}" target="_blank" rel="noopener">
        ${escapeHtml(projectId)}
      </a>
      を基準に GitHub / Cloudflare と名前突合します。値は表示しません。
    </p>
  </header>

  ${errorBanners}

  <section class="summary">
    <div class="summary-item">
      <strong>Total (GCP)</strong>: ${result.rows.length}
    </div>
    <div class="summary-item">
      <strong>Fetched</strong>: ${renderProviderCounts(result.provider_counts)}
    </div>
    <div class="summary-item">
      <strong>Diff (vs 前回 snapshot)</strong>: ${diffSummary}
    </div>
    <div class="summary-item">
      <strong>Last snapshot</strong>: ${lastSnap}
    </div>
  </section>

  <nav class="controls">
    <a class="btn btn-primary" href="?commit=1">📸 Snapshot を更新</a>
    <a class="btn" href="/service-accounts">🛠 SA Inventory</a>
    <a class="btn" href="${escapeAttr(gcpConsoleListUrl(projectId))}" target="_blank" rel="noopener">↗ GCP Console</a>
    <a class="btn" href="/api/inventory">📦 JSON</a>
  </nav>

  ${committedNote}

  <table aria-label="GCP secrets と他プロバイダーの突合表">
    <thead>
      <tr>
        <th scope="col">Name</th>
        <th scope="col">GCP <span class="muted">(${result.rows.length})</span></th>
        <th scope="col">GitHub ${renderHeaderCount(ghMatch, result.provider_counts.github)}</th>
        <th scope="col">Cloudflare ${renderHeaderCount(cfMatch, result.provider_counts.cloudflare)}</th>
        <th scope="col">Consumers</th>
        <th scope="col">GCP created</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml || `<tr><td colspan="6" class="muted">GCP に secret がありません</td></tr>`}
    </tbody>
  </table>

  ${renderServiceTokenSection(result)}

  <footer>
    <p>
      値は一切表示しません。値の確認・取り出しは
      <a href="${escapeAttr(gcpConsoleListUrl(projectId))}" target="_blank" rel="noopener">GCP コンソール</a>
      で行ってください (accessor 権限が必要)。
    </p>
    <p class="muted">
      <a href="https://github.com/ippoan/secrets-inventory">source</a>
      ·
      <a href="https://github.com/ippoan/secrets-inventory/issues/1">design issue</a>
    </p>
  </footer>
</body>
</html>`;
}

export function renderErrorPage(message: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>Secrets Inventory — error</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <header><h1>🔐 Secrets Inventory</h1></header>
  <div class="err"><pre style="margin:0;white-space:pre-wrap;word-break:break-word">${escapeHtml(message)}</pre></div>
  <p><a class="btn" href="/">↻ 再試行</a></p>
</body>
</html>`;
}

function renderRow(row: InventoryRow, projectId: string): string {
  const newClass = row.is_new_since_snapshot ? ' class="new"' : "";
  const newBadge = row.is_new_since_snapshot
    ? ` <span class="badge badge-added">new</span>`
    : "";
  const labelBadge = renderLabelBadge(extractLabels(row.gcp));
  return `<tr${newClass}>
    <td class="name-cell">
      <a class="name-link" href="${escapeAttr(gcpConsoleSecretUrl(projectId, row.name))}" target="_blank" rel="noopener">
        ${escapeHtml(row.name)}
      </a>${newBadge}${labelBadge}
    </td>
    <td>${markPresentCell(row.gcp)}</td>
    <td>${markCell(row.in_github, row.github, row.gcp)}</td>
    <td>${markCell(row.in_cloudflare, row.cloudflare, row.gcp)}</td>
    <td>${renderConsumersCell(extractLabels(row.gcp))}</td>
    <td class="ts">${row.gcp.created_at ? escapeHtml(row.gcp.created_at) : '<span class="muted">—</span>'}</td>
  </tr>`;
}

/**
 * GCP secret の labels (`extra.labels: Record<string,string>`) を取り出す。
 * provider が extra を持たない / labels キーが無い場合は空オブジェクト。
 */
function extractLabels(meta: SecretMetadata): Record<string, string> {
  const raw = meta.extra?.labels;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, string>;
  }
  return {};
}

/**
 * 行ごとの label 数 badge。可視部分には数だけ出して、tooltip で
 * `key=value` ペアを 1 行ずつ表示する。
 *
 * - labels が 0 件 → muted の `0` badge を出す (= GCP 側で labels 未設定の
 *   secret を可視化したい、隠してしまうと「label 0」と「badge が消えてる」
 *   の区別が付かない)
 * - 1 件以上 → ハイライト色 + tooltip
 */
function renderLabelBadge(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  const n = entries.length;
  if (n === 0) {
    return ` <span class="label-count label-count-zero" title="no labels">0 labels</span>`;
  }
  const tooltip = entries.map(([k, v]) => `${k}=${v}`).join("\n");
  return ` <span class="label-count" title="${escapeAttr(tooltip)}">${n} label${n === 1 ? "" : "s"}</span>`;
}

/**
 * GCP secret labels から「現在この secret を使っている consumer repo」を抽出する
 * (Refs #34)。
 *
 * ci-workflows#39 の `secret-verify-gcp.yml` (apply_labels) が打つ label 形式は:
 *   `used-by-<owner>-<repo> = active | removed`
 * key は `used-by-$(echo "$REPO_SLUG" | tr '/' '-' | tr '[:upper:]' '[:lower:]')`
 * で生成される (= `ippoan/secrets-inventory-gcp` → `used-by-ippoan-secrets-inventory-gcp`)。
 *
 * - value が `active` の label だけを consumer として数える (`removed` は撤退済みなので除外)
 * - key から `used-by-` prefix を剥がして repo 名を復元する。`/` → `-` の encode は
 *   repo 名にも `-` が含まれるため **lossy** (完全な逆変換は不可能)。GitHub の owner
 *   は単一 segment で `-` を含み得るが `/` は含まないため、最初の `-` を `/` に戻して
 *   `owner/repo` 形に近似復元する (例: `ippoan-secrets-inventory-gcp` →
 *   `ippoan/secrets-inventory-gcp`)。owner にハイフンが含まれる場合は完全復元できないが、
 *   ippoan org では問題にならない。
 */
function extractActiveConsumers(labels: Record<string, string>): string[] {
  const repos: string[] = [];
  for (const [key, value] of Object.entries(labels)) {
    if (value !== "active") continue;
    if (!key.startsWith("used-by-")) continue;
    const slug = key.slice("used-by-".length);
    if (slug.length === 0) continue;
    const firstDash = slug.indexOf("-");
    const repo = firstDash >= 0 ? `${slug.slice(0, firstDash)}/${slug.slice(firstDash + 1)}` : slug;
    repos.push(repo);
  }
  return repos.sort((a, b) => a.localeCompare(b));
}

/**
 * Consumers 列のセル。active な consumer repo の **数** を出し、hover (title) で
 * active repo 名の一覧を見せる。0 件 (= label 無し or active 0) は muted の `—`。
 */
function renderConsumersCell(labels: Record<string, string>): string {
  const repos = extractActiveConsumers(labels);
  if (repos.length === 0) {
    return `<span class="muted">—</span>`;
  }
  const tooltip = repos.join(", ");
  return `<span class="label-count" title="${escapeAttr(tooltip)}">${repos.length}</span>`;
}

/**
 * 列ヘッダーの右に出すマッチ数バッジ。
 * - 取得成功: `(matchCount/totalFetched)`
 * - 取得失敗: `(?)` (= 分母不明)
 *
 * Cloudflare / GitHub list API は **last accessed timestamp は返さない**
 * (= access 監査は audit log 側の責務)。created / updated は each row の
 * tooltip に出す。
 */
function renderHeaderCount(matchCount: number, totalFetched: number | null): string {
  if (totalFetched === null) {
    return `<span class="muted">(?)</span>`;
  }
  return `<span class="muted">(${matchCount}/${totalFetched})</span>`;
}

function renderProviderCounts(counts: {
  gcp: number;
  github: number | null;
  cloudflare: number | null;
}): string {
  const cell = (label: string, n: number | null) => {
    if (n === null) {
      return `<span class="badge badge-removed">${label}: failed</span>`;
    }
    // 0 件も成功 (empty list) を区別したいので badge-ok にしておく
    return `<span class="badge badge-ok">${label}: ${n}</span>`;
  };
  return `
    ${cell("GCP", counts.gcp)}
    ${cell("GitHub", counts.github)}
    ${cell("Cloudflare", counts.cloudflare)}
  `;
}

function renderDiffSummary(diff: { added: string[]; removed: string[] }): string {
  const a = diff.added.length;
  const r = diff.removed.length;
  if (a === 0 && r === 0) {
    return `<span class="badge badge-ok">no change</span>`;
  }
  return `
    <span class="badge badge-added">+${a} added</span>
    <span class="badge badge-removed">-${r} removed</span>
  `;
}

function renderErrorBanners(errors: {
  github?: string;
  cloudflare?: string;
  service_tokens?: string;
}): string {
  const parts: string[] = [];
  if (errors.github) {
    parts.push(
      `<div class="err">GitHub fetch failed: ${escapeHtml(errors.github)} — 該当列は <span class="unknown">?</span> として表示します</div>`,
    );
  }
  if (errors.cloudflare) {
    parts.push(
      `<div class="err">Cloudflare fetch failed: ${escapeHtml(errors.cloudflare)} — 該当列は <span class="unknown">?</span> として表示します</div>`,
    );
  }
  if (errors.service_tokens) {
    parts.push(
      `<div class="err">CF Service Token fetch failed: ${escapeHtml(errors.service_tokens)} — Service Token 突合は実施できませんでした</div>`,
    );
  }
  return parts.join("\n");
}

/**
 * ✓ / ⚠ / ✗ / ? + tooltip。
 *
 * - `present === null` → ? (provider fetch 失敗)
 * - `present === false` → ✗ (配布先に同名無し、反映漏れ候補)
 * - `present === true` + provider が GCP より **古い timestamp** → ⚠
 *   (= 配布先コピーが stale。GCP 側の rotation に追従していない可能性)
 * - `present === true` + provider が GCP 同等 or 新しい → ✓
 *
 * 古さ判定の timestamp は「latest mutation」相当として:
 *   - provider: max(created_at, updated_at)
 *   - GCP: max(created_at, updated_at)
 *
 * 注意: 現状 GCP proxy は `Secret.create_time` (親 resource の作成時刻) のみ
 * 返し、Version の `create_time` (= 最後の rotation 時刻) は返していない。
 * 親 created_at と provider updated_at の比較は「provider が GCP secret
 * 作成時より前」を検知するに留まる (GCP rotation 漏れの検知は別途 proxy
 * 側で `latest_version.create_time` を expose する必要あり)。
 *
 * 「last accessed」は GCP / GitHub / CF いずれの list API も返さないため
 * (audit log 側の責務)、本 UI では出せない。
 */
function markCell(
  present: boolean | null,
  meta: SecretMetadata | null,
  gcpMeta: SecretMetadata,
): string {
  if (present === null) {
    return `<span class="unknown" aria-label="unknown" title="fetch 失敗のため不明">?</span>`;
  }
  if (!present) {
    return `<span class="cross" aria-label="absent" title="同名 secret は配布先に存在しない (反映漏れ候補)">✗</span>`;
  }
  const stale = isStaleVsGcp(meta, gcpMeta);
  if (stale) {
    return `<span class="warn" aria-label="stale" title="${escapeAttr(stale)}">⚠</span>`;
  }
  return `<span class="check" aria-label="present" title="${escapeAttr(buildMetaTooltip(meta))}">✓</span>`;
}

/** GCP は全行 present なので専用 cell。tooltip は GCP メタデータから組み立てる。 */
function markPresentCell(meta: SecretMetadata): string {
  return `<span class="check" aria-label="present" title="${escapeAttr(buildMetaTooltip(meta))}">✓</span>`;
}

function buildMetaTooltip(meta: SecretMetadata | null): string {
  if (!meta) return "present";
  const parts: string[] = [];
  if (meta.created_at) parts.push(`created: ${meta.created_at}`);
  if (meta.updated_at) parts.push(`updated: ${meta.updated_at}`);
  return parts.length ? parts.join(" / ") : "present";
}

/**
 * provider が GCP より古い時刻なら stale 説明文を返す。判定できない (どちらかの
 * timestamp 欠落) 時は `null` で「不明=不問」扱い。
 */
function isStaleVsGcp(
  providerMeta: SecretMetadata | null,
  gcpMeta: SecretMetadata,
): string | null {
  if (!providerMeta) return null;
  const providerTs = latestTimestamp(providerMeta);
  const gcpTs = latestTimestamp(gcpMeta);
  if (!providerTs || !gcpTs) return null;
  const providerDate = Date.parse(providerTs);
  const gcpDate = Date.parse(gcpTs);
  if (Number.isNaN(providerDate) || Number.isNaN(gcpDate)) return null;
  if (providerDate >= gcpDate) return null;
  return `WARNING: provider copy is older than GCP (provider=${providerTs}, gcp=${gcpTs}) — possible un-propagated rotation`;
}

function latestTimestamp(meta: SecretMetadata): string | null {
  const c = meta.created_at ?? null;
  const u = meta.updated_at ?? null;
  if (c && u) {
    const cd = Date.parse(c);
    const ud = Date.parse(u);
    if (Number.isNaN(cd)) return u;
    if (Number.isNaN(ud)) return c;
    return ud >= cd ? u : c;
  }
  return u ?? c;
}

/**
 * CF Access Service Token の突合セクション (Refs #62)。
 *
 * 既存の GCP-centric な突合表とは別に、CF service token を GCP SM の
 * `cf_token_id` ラベル台帳と突き合わせた結果を出す。orphan (野良) /
 * missing_in_cf (記録漏れ) を上に寄せてハイライトする。
 */
function renderServiceTokenSection(result: InventoryResult): string {
  const rows = result.service_tokens.rows;
  const fetched = result.provider_counts.service_tokens;
  const counts = summarizeServiceTokenStatuses(rows);

  const bodyHtml = rows.length
    ? rows.map(renderServiceTokenRow).join("")
    : `<tr><td colspan="6" class="muted">${
        fetched === null
          ? "CF service token を取得できませんでした (上のエラーを参照)"
          : "Service Token はありません"
      }</td></tr>`;

  return `
  <section class="svc-tokens">
    <h2>🎫 CF Access Service Tokens ${renderServiceTokenCountBadge(fetched, counts)}</h2>
    <p class="sub">
      CF の service token を GCP Secret Manager の <code>cf_token_id</code> ラベル台帳と突合します。
      <span class="badge badge-removed">orphan</span> = 野良 (CF に在るが台帳に無い)、
      <span class="badge badge-warn">missing</span> = 記録漏れ (台帳に在るが CF に無い)。
      値 (client_secret) は list API がそもそも返しません。
    </p>
    <table aria-label="CF Access service token の突合表">
      <thead>
        <tr>
          <th scope="col">Status</th>
          <th scope="col">Name</th>
          <th scope="col">client_id</th>
          <th scope="col">cf_token_id</th>
          <th scope="col">GCP 台帳</th>
          <th scope="col">created</th>
        </tr>
      </thead>
      <tbody>${bodyHtml}</tbody>
    </table>
  </section>`;
}

function renderServiceTokenRow(row: ServiceTokenRow): string {
  const name = row.cf?.name ?? row.gcp?.name ?? "—";
  const clientId = serviceTokenClientId(row.cf);
  const gcpName = row.gcp?.name ?? null;
  const created = row.cf?.created_at ?? row.gcp?.created_at ?? null;
  const trClass = row.status === "ok" ? "" : ' class="drift"';
  return `<tr${trClass}>
    <td>${renderServiceTokenStatus(row.status)}</td>
    <td class="name-cell">${escapeHtml(name)}</td>
    <td class="name-cell">${clientId ? escapeHtml(clientId) : '<span class="muted">—</span>'}</td>
    <td class="name-cell">${row.cf_token_id ? escapeHtml(row.cf_token_id) : '<span class="muted">—</span>'}</td>
    <td class="name-cell">${gcpName ? escapeHtml(gcpName) : '<span class="muted">—</span>'}</td>
    <td class="ts">${created ? escapeHtml(created) : '<span class="muted">—</span>'}</td>
  </tr>`;
}

function renderServiceTokenStatus(status: ServiceTokenStatus): string {
  switch (status) {
    case "ok":
      return `<span class="badge badge-ok" title="CF token と GCP SM 台帳が突合できた">ok</span>`;
    case "orphan":
      return `<span class="badge badge-removed" title="CF に在るが GCP SM 台帳 (cf_token_id ラベル) に無い = 野良 service token">orphan</span>`;
    case "missing_in_cf":
      return `<span class="badge badge-warn" title="GCP SM 台帳に在るが CF に対応 token が無い = 記録漏れ / 失効後の掃除漏れ">missing</span>`;
  }
}

function serviceTokenClientId(cf: SecretMetadata | null): string | null {
  const v = cf?.extra?.client_id;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function summarizeServiceTokenStatuses(rows: ServiceTokenRow[]): {
  ok: number;
  orphan: number;
  missing: number;
} {
  let ok = 0;
  let orphan = 0;
  let missing = 0;
  for (const r of rows) {
    if (r.status === "ok") ok++;
    else if (r.status === "orphan") orphan++;
    else missing++;
  }
  return { ok, orphan, missing };
}

function renderServiceTokenCountBadge(
  fetched: number | null,
  counts: { ok: number; orphan: number; missing: number },
): string {
  if (fetched === null) {
    return `<span class="muted">(?)</span>`;
  }
  const parts = [`<span class="muted">(${fetched})</span>`];
  if (counts.orphan > 0) {
    parts.push(`<span class="badge badge-removed">${counts.orphan} orphan</span>`);
  }
  if (counts.missing > 0) {
    parts.push(`<span class="badge badge-warn">${counts.missing} missing</span>`);
  }
  return parts.join(" ");
}

/**
 * テキスト挿入用 escape。HTML 属性値には escapeAttr を使う。
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 属性値専用 (escapeHtml と現状同じ挻動)。意図を明示するためのエイリアス。 */
export function escapeAttr(s: string): string {
  return escapeHtml(s);
}

const PAGE_STYLES = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #0d1117;
    color: #c9d1d9;
    margin: 0;
    padding: 24px;
    font-size: 14px;
    line-height: 1.5;
  }
  header h1 { margin: 0 0 4px; font-size: 22px; }
  header .sub { margin: 0 0 16px; color: #8b949e; }
  .muted { color: #8b949e; }
  .summary {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 12px 18px;
    margin-bottom: 16px;
    display: flex;
    flex-wrap: wrap;
    gap: 24px;
    align-items: center;
  }
  .summary-item strong { color: #c9d1d9; margin-right: 4px; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    margin-left: 4px;
  }
  .badge-added   { background: #1f3a26; color: #56d364; }
  .badge-removed { background: #3a1f1f; color: #ff7b72; }
  .badge-ok      { background: #1f2937; color: #8b949e; }
  .badge-warn    { background: #3a2f1a; color: #f0883e; }
  /* Per-secret label count chip in the name cell. Tooltip shows the
     full key=value list (newline-separated). cursor:help is the
     standard browser hint that there is a tooltip on hover. */
  .label-count {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    margin-left: 6px;
    background: #1c2a3a;
    color: #79c0ff;
    border: 1px solid #30363d;
    cursor: help;
    white-space: nowrap;
  }
  .label-count-zero { background: #1f2937; color: #8b949e; }
  .controls {
    margin-bottom: 16px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .btn {
    background: #21262d;
    color: #c9d1d9;
    border: 1px solid #30363d;
    padding: 6px 12px;
    border-radius: 6px;
    text-decoration: none;
    font-size: 13px;
    cursor: pointer;
  }
  .btn:hover { background: #30363d; }
  .btn-primary {
    background: #1f6feb;
    border-color: #1f6feb;
    color: #fff;
  }
  .btn-primary:hover { background: #388bfd; border-color: #388bfd; }
  table {
    width: 100%;
    border-collapse: collapse;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 6px;
    overflow: hidden;
  }
  th, td {
    padding: 8px 12px;
    text-align: left;
    border-bottom: 1px solid #30363d;
    font-size: 13px;
  }
  th { background: #161b22; font-weight: 600; color: #8b949e; }
  tr:last-child td { border-bottom: none; }
  tr.new td { background: rgba(86, 211, 100, 0.08); }
  tr.drift td { background: rgba(255, 123, 114, 0.08); }
  .svc-tokens { margin-top: 28px; }
  .svc-tokens h2 { font-size: 18px; margin: 0 0 4px; }
  .svc-tokens .sub { margin: 0 0 12px; color: #8b949e; }
  .svc-tokens code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 12px;
  }
  .name-cell, .ts {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .name-link { color: #58a6ff; text-decoration: none; }
  .name-link:hover { text-decoration: underline; }
  .check   { color: #56d364; font-weight: 700; }
  .cross   { color: #ff7b72; font-weight: 700; }
  .unknown { color: #d29922; font-weight: 700; }
  .warn    { color: #f0883e; font-weight: 700; cursor: help; }
  .err {
    background: #2d1b1b;
    border: 1px solid #ff7b72;
    color: #ff7b72;
    padding: 10px 14px;
    border-radius: 6px;
    margin-bottom: 12px;
  }
  .hint {
    background: #1c2c1c;
    border: 1px solid #56d364;
    color: #56d364;
    padding: 8px 14px;
    border-radius: 6px;
    margin: 0 0 12px;
  }
  footer { margin-top: 24px; color: #8b949e; font-size: 12px; }
  footer a { color: #58a6ff; text-decoration: none; }
`;
