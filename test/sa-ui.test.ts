import { describe, it, expect } from "vitest";
import { renderSaInventoryPage } from "../src/sa-ui";
import type { SaInventoryResult } from "../src/sa-inventory";

const baseResult: SaInventoryResult = {
  gcp_project_id: "cloudsql-sv",
  fetched_at: "2026-05-22T00:00:00Z",
  summary: { total: 3, ok: 1, warn: 1, candidate: 1 },
  rows: [
    {
      sa: {
        email: "sa-norole@p.iam.gserviceaccount.com",
        unique_id: "1",
        disabled: false,
        roles: [],
        keys: [],
      },
      audit: {
        flags: ["no-role"],
        status: "candidate",
        oldest_user_key_age_days: null,
        user_managed_key_count: 0,
      },
    },
    {
      sa: {
        email: "9-compute@developer.gserviceaccount.com",
        display_name: "Compute default",
        description: "auto-created by GCE",
        unique_id: "2",
        disabled: false,
        roles: [
          "roles/storage.objectViewer",
          "roles/secretmanager.viewer",
          "roles/logging.logWriter",
          "roles/monitoring.metricWriter",
        ],
        keys: [],
      },
      audit: {
        flags: ["default-sa"],
        status: "warn",
        oldest_user_key_age_days: null,
        user_managed_key_count: 0,
      },
    },
    {
      sa: {
        email: "sa-ok@p.iam.gserviceaccount.com",
        unique_id: "3",
        disabled: false,
        roles: ["roles/foo"],
        keys: [
          { id: "k1", key_type: "USER_MANAGED", valid_after: "2026-05-01T00:00:00Z" },
        ],
      },
      audit: {
        flags: [],
        status: "ok",
        oldest_user_key_age_days: 21,
        user_managed_key_count: 1,
      },
    },
  ],
};

describe("renderSaInventoryPage", () => {
  it("includes project id, summary counters, and all rows", () => {
    const html = renderSaInventoryPage(baseResult);
    expect(html).toContain("cloudsql-sv");
    expect(html).toContain("sa-norole@p.iam.gserviceaccount.com");
    expect(html).toContain("9-compute@developer.gserviceaccount.com");
    expect(html).toContain("sa-ok@p.iam.gserviceaccount.com");
    // summary counter
    expect(html).toContain("🔴 候補</strong>: 1");
    expect(html).toContain("🟡 warn</strong>: 1");
    expect(html).toContain("🟢 ok</strong>: 1");
  });

  it("renders flags as chips with tooltips", () => {
    const html = renderSaInventoryPage(baseResult);
    expect(html).toContain(`class="flag"`);
    expect(html).toMatch(/no-role/);
    expect(html).toContain("project IAM policy");
  });

  it("renders + N more for >3 roles", () => {
    const html = renderSaInventoryPage(baseResult);
    expect(html).toContain(`+1</span>`);
    // 3 表示 + 1 hidden = 4 roles
    expect(html).toMatch(/storage\.objectViewer/);
  });

  it("shows display_name + description in email tooltip", () => {
    const html = renderSaInventoryPage(baseResult);
    expect(html).toContain("name: Compute default");
    expect(html).toContain("desc: auto-created by GCE");
  });

  it("renders a discoverable JSON link in the header", () => {
    const html = renderSaInventoryPage(baseResult);
    expect(html).toContain(`class="json-link"`);
    expect(html).toContain(`href="?format=json"`);
    expect(html).toContain(">JSON</a>");
  });

  it("filters by status when opts.filter is set", () => {
    const html = renderSaInventoryPage(baseResult, { filter: "candidate" });
    expect(html).toContain("sa-norole@");
    expect(html).not.toContain("sa-ok@p.iam.gserviceaccount.com");
    expect(html).not.toContain("9-compute@developer");
  });

  it("renders empty state when filter excludes all", () => {
    const result = {
      ...baseResult,
      rows: [],
      summary: { total: 0, ok: 0, warn: 0, candidate: 0 },
    };
    const html = renderSaInventoryPage(result);
    expect(html).toContain("該当 SA なし");
  });

  it("highlights active filter chip", () => {
    const all = renderSaInventoryPage(baseResult);
    expect(all).toContain(`class="summary-item active"`); // すべて
    const candidate = renderSaInventoryPage(baseResult, { filter: "candidate" });
    expect(candidate).toMatch(/summary-item active[^>]*>\s*<a href="\?status=candidate"/);
    const warn = renderSaInventoryPage(baseResult, { filter: "warn" });
    expect(warn).toMatch(/summary-item active[^>]*>\s*<a href="\?status=warn"/);
    const ok = renderSaInventoryPage(baseResult, { filter: "ok" });
    expect(ok).toMatch(/summary-item active[^>]*>\s*<a href="\?status=ok"/);
  });

  it("shows '—' for SAs with no user-managed keys (oldest_user_key_age_days null)", () => {
    const html = renderSaInventoryPage(baseResult);
    expect(html).toMatch(/<span class="muted">—<\/span>/);
  });

  it("highlights oldest key age in warn color when key-old is flagged", () => {
    const result: SaInventoryResult = {
      ...baseResult,
      rows: [
        {
          sa: {
            email: "sa-keyold@p.iam.gserviceaccount.com",
            unique_id: "9",
            disabled: false,
            roles: ["roles/foo"],
            keys: [
              { id: "k", key_type: "USER_MANAGED", valid_after: "2025-01-01T00:00:00Z" },
            ],
          },
          audit: {
            flags: ["key-old"],
            status: "warn",
            oldest_user_key_age_days: 500,
            user_managed_key_count: 1,
          },
        },
      ],
      summary: { total: 1, ok: 0, warn: 1, candidate: 0 },
    };
    const html = renderSaInventoryPage(result);
    expect(html).toContain(`<span class="warn">500 日</span>`);
  });

  it("renders なし when SA has no roles", () => {
    const html = renderSaInventoryPage(baseResult);
    expect(html).toContain(`<span class="muted">なし</span>`);
  });

  it("renders disabled tag in last column", () => {
    const result: SaInventoryResult = {
      ...baseResult,
      rows: [
        {
          sa: {
            email: "sa-dis@p.iam.gserviceaccount.com",
            unique_id: "x",
            disabled: true,
            roles: ["roles/foo"],
            keys: [],
          },
          audit: {
            flags: ["disabled"],
            status: "candidate",
            oldest_user_key_age_days: null,
            user_managed_key_count: 0,
          },
        },
      ],
      summary: { total: 1, ok: 0, warn: 0, candidate: 1 },
    };
    const html = renderSaInventoryPage(result);
    expect(html).toContain(">disabled</td>");
  });

  it("escapes potentially malicious display_name", () => {
    const result: SaInventoryResult = {
      ...baseResult,
      rows: [
        {
          sa: {
            email: "x@p.iam.gserviceaccount.com",
            display_name: "<script>alert(1)</script>",
            unique_id: "x",
            disabled: false,
            roles: ["roles/foo"],
            keys: [],
          },
          audit: {
            flags: [],
            status: "ok",
            oldest_user_key_age_days: null,
            user_managed_key_count: 0,
          },
        },
      ],
      summary: { total: 1, ok: 1, warn: 0, candidate: 0 },
    };
    const html = renderSaInventoryPage(result);
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("shows fetched_at in footer + issue link", () => {
    const html = renderSaInventoryPage(baseResult);
    expect(html).toContain("2026-05-22T00:00:00Z");
    expect(html).toContain("issues/20");
  });

  it("omits uid: tooltip part when unique_id is empty", () => {
    const result: SaInventoryResult = {
      ...baseResult,
      rows: [
        {
          sa: {
            email: "no-uid@p.iam.gserviceaccount.com",
            unique_id: "",
            disabled: false,
            roles: ["roles/foo"],
            keys: [],
          },
          audit: {
            flags: [],
            status: "ok",
            oldest_user_key_age_days: null,
            user_managed_key_count: 0,
          },
        },
      ],
      summary: { total: 1, ok: 1, warn: 0, candidate: 0 },
    };
    const html = renderSaInventoryPage(result);
    expect(html).not.toMatch(/uid:\s*\//);
  });

  it("renders non-prefix roles verbatim (covers shortRole else branch)", () => {
    const result: SaInventoryResult = {
      ...baseResult,
      rows: [
        {
          sa: {
            email: "weird-role@p.iam.gserviceaccount.com",
            unique_id: "1",
            disabled: false,
            roles: ["custom/foo"], // not starting with roles/
            keys: [],
          },
          audit: {
            flags: [],
            status: "ok",
            oldest_user_key_age_days: null,
            user_managed_key_count: 0,
          },
        },
      ],
      summary: { total: 1, ok: 1, warn: 0, candidate: 0 },
    };
    const html = renderSaInventoryPage(result);
    expect(html).toContain(">custom/foo</span>");
  });
});
