import type { InventoryResult } from "./inventory";
import type { InventoryRow } from "./diff";
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
    <a class="btn" href="${escapeAttr(gcpConsoleListUrl(projectId))}" target="_blank" rel="noopener">↗ GCP Console</a>
    <a class="btn" href="/api/inventory">📦 JSON</a>
  </nav>

  ${committedNote}

  <table aria-label="GCP secrets と他プロバイダーの突合表">
    <thead>
      <tr>
        <th scope="col">Name</th>
        <th scope="col">GCP</th>
        <th scope="col">GitHub</th>
        <th scope="col">Cloudflare</th>
        <th scope="col">GCP created</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml || `<tr><td colspan="5" class="muted">GCP に secret がありません</td></tr>`}
    </tbody>
  </table>

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
  return `<tr${newClass}>
    <td class="name-cell">
      <a class="name-link" href="${escapeAttr(gcpConsoleSecretUrl(projectId, row.name))}" target="_blank" rel="noopener">
        ${escapeHtml(row.name)}
      </a>${newBadge}
    </td>
    <td>${MARK_PRESENT}</td>
    <td>${markCell(row.in_github)}</td>
    <td>${markCell(row.in_cloudflare)}</td>
    <td class="ts">${row.gcp.created_at ? escapeHtml(row.gcp.created_at) : '<span class="muted">—</span>'}</td>
  </tr>`;
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

function renderErrorBanners(errors: { github?: string; cloudflare?: string }): string {
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
  return parts.join("\n");
}

const MARK_PRESENT = `<span class="check" aria-label="present">✓</span>`;
const MARK_ABSENT = `<span class="cross" aria-label="absent">✗</span>`;
const MARK_UNKNOWN = `<span class="unknown" aria-label="unknown" title="fetch 失敗のため不明">?</span>`;

function markCell(b: boolean | null): string {
  if (b === null) return MARK_UNKNOWN;
  return b ? MARK_PRESENT : MARK_ABSENT;
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

/** 属性値専用 (escapeHtml と現状同じ挙動)。意図を明示するためのエイリアス。 */
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
  .name-cell, .ts {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .name-link { color: #58a6ff; text-decoration: none; }
  .name-link:hover { text-decoration: underline; }
  .check   { color: #56d364; font-weight: 700; }
  .cross   { color: #ff7b72; font-weight: 700; }
  .unknown { color: #d29922; font-weight: 700; }
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
