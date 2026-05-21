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
            is_new_since_snapshot: false,
          },
        ],
        errors: { github: "401 Unauthorized" },
      }),
    );
    expect(html).toMatch(/aria-label="unknown"/);
    expect(html).toContain("GitHub fetch failed");
    expect(html).toContain("401 Unauthorized");
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
            is_new_since_snapshot: false,
          },
        ],
      }),
    );
    expect(html).not.toMatch(/secret_value|"value"/i);
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
