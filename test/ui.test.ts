import { describe, it, expect } from "vitest";
import {
  renderInventoryPage,
  renderErrorPage,
  escapeHtml,
} from "../src/ui";
import type { InventoryResult } from "../src/inventory";

function baseResult(overrides: Partial<InventoryResult> = {}): InventoryResult {
  return {
    gcp_project_id: "cloudsql-sv",
    rows: [],
    diff: { added: [], removed: [] },
    previous_snapshot_at: null,
    snapshot_at: null,
    snapshot_committed: false,
    errors: {},
    provider_counts: { gcp: 0, github: 0, cloudflare: 0 },
    ...overrides,
  };
}

describe("escapeHtml", () => {
  it("escapes the dangerous five chars", () => {
    expect(escapeHtml(`<a href="x" title='t'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;t&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("renderInventoryPage", () => {
  it("renders a no-secret state with friendly empty row", () => {
    const html = renderInventoryPage(baseResult());
    expect(html).toContain("<title>Secrets Inventory — cloudsql-sv</title>");
    expect(html).toContain("GCP に secret がありません");
    expect(html).toContain("none — まだ snapshot を撮っていません");
  });

  it("escapes the project id (defensive — comes from env config)", () => {
    const html = renderInventoryPage(
      baseResult({ gcp_project_id: "<bad>" }),
    );
    expect(html).toContain("&lt;bad&gt;");
    expect(html).not.toContain("<bad>");
  });

  it("renders a row per GCP secret with marks for each provider column", () => {
    const html = renderInventoryPage(
      baseResult({
        rows: [
          {
            name: "STRIPE_API_KEY",
            gcp: { name: "STRIPE_API_KEY", created_at: "2026-01-01T00:00:00Z" },
            in_github: true,
            in_cloudflare: false,
            github: null,
            cloudflare: null,
            is_new_since_snapshot: false,
          },
        ],
      }),
    );
    expect(html).toContain("STRIPE_API_KEY");
    expect(html).toContain("2026-01-01T00:00:00Z");
    // GCP 列 + in_github=true = 2 個の ✓ が含まれる
    const checkCount = (html.match(/aria-label="present"/g) ?? []).length;
    expect(checkCount).toBeGreaterThanOrEqual(2);
    // in_cloudflare=false = 少なくとも 1 個の ✗
    expect(html).toMatch(/aria-label="absent"/);
  });

  it("marks 'new' rows with the new badge + row class", () => {
    const html = renderInventoryPage(
      baseResult({
        rows: [
          {
            name: "NEW_SECRET",
            gcp: { name: "NEW_SECRET", created_at: null },
            in_github: false,
            in_cloudflare: false,
            github: null,
            cloudflare: null,
            is_new_since_snapshot: true,
          },
        ],
        diff: { added: ["NEW_SECRET"], removed: [] },
        previous_snapshot_at: "2026-05-20T00:00:00Z",
      }),
    );
    expect(html).toContain('<tr class="new">');
    expect(html).toContain(">new<");
    expect(html).toContain("+1 added");
  });

  it("renders ? for unknown (failed provider) and surfaces error banner", () => {
    const html = renderInventoryPage(
      baseResult({
        rows: [
          {
            name: "X",
            gcp: { name: "X" },
            in_github: null,
            in_cloudflare: false,
            github: null,
            cloudflare: null,
            is_new_since_snapshot: false,
          },
        ],
        errors: { github: "401 Unauthorized" },
        provider_counts: { gcp: 1, github: null, cloudflare: 0 },
      }),
    );
    expect(html).toMatch(/aria-label="unknown"/);
    expect(html).toContain("GitHub fetch failed");
    expect(html).toContain("401 Unauthorized");
    // failed provider は "failed" バッジで明示
    expect(html).toContain("GitHub: failed");
  });

  it("renders 'Fetched' counts per provider in the summary", () => {
    const html = renderInventoryPage(
      baseResult({
        provider_counts: { gcp: 34, github: 12, cloudflare: 5 },
        rows: [],
      }),
    );
    expect(html).toContain("GCP: 34");
    expect(html).toContain("GitHub: 12");
    expect(html).toContain("Cloudflare: 5");
  });

  it("renders 'github: 0' (not failed) when GitHub fetched successfully but empty", () => {
    const html = renderInventoryPage(
      baseResult({
        provider_counts: { gcp: 1, github: 0, cloudflare: 1 },
      }),
    );
    // 0 件取得 (= empty list) と fetch 失敗 (= null) を区別する
    expect(html).toContain("GitHub: 0");
    expect(html).not.toContain("GitHub: failed");
  });

  it("renders a positive hint when snapshot was just committed", () => {
    const html = renderInventoryPage(
      baseResult({
        snapshot_committed: true,
        snapshot_at: "2026-05-21T10:00:00Z",
      }),
    );
    expect(html).toContain("snapshot を 2026-05-21T10:00:00Z で更新しました");
  });

  it("renders 'no change' badge when diff is empty but a snapshot exists", () => {
    const html = renderInventoryPage(
      baseResult({
        rows: [
          {
            name: "X",
            gcp: { name: "X" },
            in_github: true,
            in_cloudflare: true,
            github: null,
            cloudflare: null,
            is_new_since_snapshot: false,
          },
        ],
        diff: { added: [], removed: [] },
        previous_snapshot_at: "2026-05-20T00:00:00Z",
      }),
    );
    expect(html).toContain("no change");
  });

  it("never includes a 'value' field in the rendered HTML (data leak guard)", () => {
    const html = renderInventoryPage(
      baseResult({
        rows: [
          {
            name: "TOKEN",
            // value/secret-like keys should never appear in render output
            gcp: { name: "TOKEN", created_at: "2026-01-01T00:00:00Z" },
            in_github: true,
            in_cloudflare: true,
            github: null,
            cloudflare: null,
            is_new_since_snapshot: false,
          },
        ],
      }),
    );
    expect(html).not.toMatch(/secret_value|"value"/i);
  });

  it("renders ⚠ when a provider row is older than GCP (possible stale rotation)", () => {
    const html = renderInventoryPage(
      baseResult({
        rows: [
          {
            name: "STRIPE_API_KEY",
            gcp: {
              name: "STRIPE_API_KEY",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-04-01T00:00:00Z", // GCP rotated 2026-04
            },
            in_github: true,
            in_cloudflare: true,
            github: {
              name: "STRIPE_API_KEY",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-02-01T00:00:00Z", // GitHub copy is older
            },
            cloudflare: {
              name: "STRIPE_API_KEY",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-04-05T00:00:00Z", // CF copy newer than GCP, OK
            },
            is_new_since_snapshot: false,
          },
        ],
      }),
    );
    // GitHub 列は ⚠ (stale)
    expect(html).toMatch(/aria-label="stale"[^>]*>⚠</);
    expect(html).toContain("provider copy is older than GCP");
    // CF 列は ✓ (GCP より新しい / 同等なら問題なし)
    // ⚠ は 1 つだけ (GitHub のみ)
    const warnCount = (html.match(/aria-label="stale"/g) ?? []).length;
    expect(warnCount).toBe(1);
  });

  it("does NOT mark stale when provider has no timestamp (cannot judge → ✓)", () => {
    const html = renderInventoryPage(
      baseResult({
        rows: [
          {
            name: "X",
            gcp: { name: "X", updated_at: "2026-04-01T00:00:00Z" },
            in_github: true,
            in_cloudflare: false,
            github: null, // matched flag is true but metadata is missing
            cloudflare: null,
            is_new_since_snapshot: false,
          },
        ],
      }),
    );
    // metadata 不足だけで stale 扱いはしない (= false positive 回避)
    expect(html).not.toMatch(/aria-label="stale"/);
  });

  it("table header shows match count per provider column", () => {
    const html = renderInventoryPage(
      baseResult({
        rows: [
          {
            name: "A",
            gcp: { name: "A" },
            in_github: true,
            in_cloudflare: false,
            github: null,
            cloudflare: null,
            is_new_since_snapshot: false,
          },
          {
            name: "B",
            gcp: { name: "B" },
            in_github: false,
            in_cloudflare: true,
            github: null,
            cloudflare: null,
            is_new_since_snapshot: false,
          },
        ],
        provider_counts: { gcp: 2, github: 10, cloudflare: 5 },
      }),
    );
    // GCP 列ヘッダー: 件数だけ (source of truth)
    expect(html).toMatch(/GCP <span class="muted">\(2\)<\/span>/);
    // GitHub 列ヘッダー: (matched/total fetched)
    expect(html).toMatch(/GitHub <span class="muted">\(1\/10\)<\/span>/);
    expect(html).toMatch(/Cloudflare <span class="muted">\(1\/5\)<\/span>/);
  });

  it("table header shows (?) when provider fetch failed", () => {
    const html = renderInventoryPage(
      baseResult({
        rows: [
          {
            name: "A",
            gcp: { name: "A" },
            in_github: null,
            in_cloudflare: true,
            github: null,
            cloudflare: null,
            is_new_since_snapshot: false,
          },
        ],
        provider_counts: { gcp: 1, github: null, cloudflare: 1 },
        errors: { github: "fail" },
      }),
    );
    expect(html).toMatch(/GitHub <span class="muted">\(\?\)<\/span>/);
  });

  it("links secret names to per-secret GCP console URL", () => {
    const html = renderInventoryPage(
      baseResult({
        rows: [
          {
            name: "FOO",
            gcp: { name: "FOO" },
            in_github: true,
            in_cloudflare: true,
            github: null,
            cloudflare: null,
            is_new_since_snapshot: false,
          },
        ],
      }),
    );
    expect(html).toContain(
      "https://console.cloud.google.com/security/secret-manager/secret/FOO/versions?project=cloudsql-sv",
    );
  });
});

describe("renderErrorPage", () => {
  it("escapes the error message", () => {
    const html = renderErrorPage("<script>alert(1)</script>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
