import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderSaInventoryPage, renderLastAuth, isUndeletableDefaultSa } from "../src/sa-ui";
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

  it("renders 「最終認証」 column header", () => {
    const html = renderSaInventoryPage(baseResult);
    expect(html).toContain("<th>最終認証</th>");
  });

  it("uses colspan=8 for the empty-state row (= column count after 最終認証 added)", () => {
    const result = {
      ...baseResult,
      rows: [],
      summary: { total: 0, ok: 0, warn: 0, candidate: 0 },
    };
    const html = renderSaInventoryPage(result);
    expect(html).toContain(`colspan="8"`);
  });

  it("renders last_authenticated_at as 「N 日前」 for each row when present", () => {
    // Date.now() を fixate して "117 日前" を deterministic に検証
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00Z"));
    try {
      const result: SaInventoryResult = {
        ...baseResult,
        rows: [
          {
            sa: {
              email: "active@p.iam.gserviceaccount.com",
              unique_id: "1",
              disabled: false,
              roles: ["roles/foo"],
              keys: [],
              last_authenticated_at: "2026-01-25T00:00:00Z", // 117 日前 (jan25→may22, no T offset)
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
      expect(html).toMatch(/>117 日前<\/span>/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("renderLastAuth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 「—」 with explanatory tooltip when undefined", () => {
    const html = renderLastAuth(undefined);
    expect(html).toContain("—");
    expect(html).toContain(`class="muted"`);
    expect(html).toContain("Policy Analyzer");
  });

  it("returns 「—」 when empty string", () => {
    expect(renderLastAuth("")).toContain("—");
  });

  it("renders N 日前 for typical RFC3339 input", () => {
    expect(renderLastAuth("2026-05-15T07:00:00Z")).toMatch(/>6 日前<\/span>/);
  });

  it("renders 0 日前 for today", () => {
    expect(renderLastAuth("2026-05-22T00:00:00Z")).toMatch(/>0 日前<\/span>/);
  });

  it("applies warn class when over 90 days", () => {
    const html = renderLastAuth("2026-01-01T07:00:00Z"); // ~141 日前
    expect(html).toContain(`class="warn"`);
    expect(html).toMatch(/14[01] 日前/);
  });

  it("does not apply warn class for fresh auth", () => {
    const html = renderLastAuth("2026-05-15T07:00:00Z"); // 6 日前
    expect(html).not.toContain(`class="warn"`);
  });

  it("clamps future timestamps to 「0 日前」 (clock drift / api bug)", () => {
    expect(renderLastAuth("2027-01-01T00:00:00Z")).toMatch(/>0 日前<\/span>/);
  });

  it("returns 「?」 on unparseable string", () => {
    expect(renderLastAuth("not-a-date")).toContain(">?</span>");
  });

  it("preserves the original RFC3339 as tooltip", () => {
    const html = renderLastAuth("2026-05-15T07:00:00Z");
    expect(html).toContain(`title="2026-05-15T07:00:00Z"`);
  });
});

describe("isUndeletableDefaultSa", () => {
  it("flags Compute default SA (@developer.gserviceaccount.com)", () => {
    expect(isUndeletableDefaultSa("747065218280-compute@developer.gserviceaccount.com")).toBe(true);
  });

  it("flags App Engine default SA (@appspot.gserviceaccount.com)", () => {
    expect(isUndeletableDefaultSa("cloudsql-sv@appspot.gserviceaccount.com")).toBe(true);
  });

  it("does not flag normal user-managed SA (@*.iam.gserviceaccount.com)", () => {
    expect(isUndeletableDefaultSa("cloud-run-deployer@cloudsql-sv.iam.gserviceaccount.com")).toBe(false);
  });
});

describe("renderSaInventoryPage — undeletable badge", () => {
  it("renders 🔒 削除不可 badge for @developer.gserviceaccount.com row", () => {
    const html = renderSaInventoryPage(baseResult);
    // badge must appear, attached to the developer SA row
    expect(html).toContain("🔒 削除不可");
    // confirm it lands on the compute default SA row (badge appears after email)
    const idx = html.indexOf("9-compute@developer.gserviceaccount.com");
    const badgeIdx = html.indexOf("🔒 削除不可", idx);
    expect(badgeIdx).toBeGreaterThan(idx);
    // user-managed SA row must NOT carry the badge
    const okIdx = html.indexOf("sa-ok@p.iam.gserviceaccount.com");
    const badgeAfterOk = html.indexOf("🔒 削除不可", okIdx);
    expect(badgeAfterOk).toBe(-1);
  });

  it("adds undeletable class on the row for styling hook", () => {
    const html = renderSaInventoryPage(baseResult);
    expect(html).toMatch(/<tr class="status-warn undeletable">/);
  });

  it("updates default-sa tooltip to explain non-deletability", () => {
    const html = renderSaInventoryPage(baseResult);
    expect(html).toContain("削除不可");
  });
});

describe("renderSaInventoryPage — dark mode styles", () => {
  it("emits a prefers-color-scheme:dark media block for chip readability", () => {
    const html = renderSaInventoryPage(baseResult);
    expect(html).toContain("@media (prefers-color-scheme: dark)");
  });

  it("overrides flag/role chip text colors with brighter dark-mode variants", () => {
    const html = renderSaInventoryPage(baseResult);
    // dark mode 用の明るい文字色 (#ffb3b8 = flag, #9ec5ff = role)
    expect(html).toContain("#ffb3b8");
    expect(html).toContain("#9ec5ff");
  });
});
