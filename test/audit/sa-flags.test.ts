import { describe, it, expect } from "vitest";
import {
  auditServiceAccount,
  deriveStatus,
  isDefaultSa,
  summarize,
  KEY_OLD_THRESHOLD_DAYS,
  KEY_ANOMALY_THRESHOLD,
} from "../../src/audit/sa-flags";
import type { ServiceAccount } from "../../src/providers/gcp-iam";

const now = new Date("2026-05-22T00:00:00Z");

function baseSa(overrides: Partial<ServiceAccount> = {}): ServiceAccount {
  return {
    email: "sa@p.iam.gserviceaccount.com",
    unique_id: "1",
    disabled: false,
    roles: ["roles/secretmanager.viewer"],
    keys: [],
    ...overrides,
  };
}

describe("auditServiceAccount", () => {
  it("returns ok for a healthy SA", () => {
    const a = auditServiceAccount(baseSa(), now);
    expect(a.flags).toEqual([]);
    expect(a.status).toBe("ok");
    expect(a.oldest_user_key_age_days).toBeNull();
    expect(a.user_managed_key_count).toBe(0);
  });

  it("flags no-role", () => {
    const a = auditServiceAccount(baseSa({ roles: [] }), now);
    expect(a.flags).toContain("no-role");
    expect(a.status).toBe("candidate");
  });

  it("flags disabled (still 候補)", () => {
    const a = auditServiceAccount(baseSa({ disabled: true }), now);
    expect(a.flags).toContain("disabled");
    expect(a.status).toBe("candidate");
  });

  it("flags default-sa for *-compute@developer.gserviceaccount.com", () => {
    const a = auditServiceAccount(
      baseSa({ email: "123456-compute@developer.gserviceaccount.com" }),
      now,
    );
    expect(a.flags).toContain("default-sa");
    expect(a.status).toBe("warn");
  });

  it("flags default-sa for *@appspot.gserviceaccount.com", () => {
    const a = auditServiceAccount(
      baseSa({ email: "my-project@appspot.gserviceaccount.com" }),
      now,
    );
    expect(a.flags).toContain("default-sa");
  });

  it(`flags key-anomaly when user-managed keys >= ${KEY_ANOMALY_THRESHOLD}`, () => {
    const a = auditServiceAccount(
      baseSa({
        keys: [
          { id: "1", key_type: "USER_MANAGED" },
          { id: "2", key_type: "USER_MANAGED" },
          { id: "3", key_type: "USER_MANAGED" },
        ],
      }),
      now,
    );
    expect(a.flags).toContain("key-anomaly");
    expect(a.user_managed_key_count).toBe(3);
    expect(a.status).toBe("warn");
  });

  it(`flags key-old when oldest user key is > ${KEY_OLD_THRESHOLD_DAYS} days`, () => {
    // 365 日前 = 2025-05-22 で作成された key
    const oldKey = "2025-05-22T00:00:00Z";
    const a = auditServiceAccount(
      baseSa({
        keys: [{ id: "1", key_type: "USER_MANAGED", valid_after: oldKey }],
      }),
      now,
    );
    expect(a.flags).toContain("key-old");
    expect(a.oldest_user_key_age_days).toBe(365);
  });

  it(`does not flag key-old when key is exactly ${KEY_OLD_THRESHOLD_DAYS} days old (strict >)`, () => {
    const threshold = new Date(now.getTime() - KEY_OLD_THRESHOLD_DAYS * 86400 * 1000);
    const a = auditServiceAccount(
      baseSa({
        keys: [
          {
            id: "1",
            key_type: "USER_MANAGED",
            valid_after: threshold.toISOString(),
          },
        ],
      }),
      now,
    );
    expect(a.flags).not.toContain("key-old");
  });

  it("ignores SYSTEM_MANAGED keys for both age and count", () => {
    const a = auditServiceAccount(
      baseSa({
        keys: [
          { id: "1", key_type: "SYSTEM_MANAGED", valid_after: "2024-01-01T00:00:00Z" },
          { id: "2", key_type: "SYSTEM_MANAGED" },
          { id: "3", key_type: "SYSTEM_MANAGED" },
        ],
      }),
      now,
    );
    expect(a.flags).not.toContain("key-anomaly");
    expect(a.flags).not.toContain("key-old");
    expect(a.user_managed_key_count).toBe(0);
    expect(a.oldest_user_key_age_days).toBeNull();
  });

  it("skips keys with missing valid_after for age calc", () => {
    const a = auditServiceAccount(
      baseSa({
        keys: [{ id: "1", key_type: "USER_MANAGED" }],
      }),
      now,
    );
    expect(a.oldest_user_key_age_days).toBeNull();
  });

  it("skips keys with invalid valid_after date", () => {
    const a = auditServiceAccount(
      baseSa({
        keys: [{ id: "1", key_type: "USER_MANAGED", valid_after: "not-a-date" }],
      }),
      now,
    );
    expect(a.oldest_user_key_age_days).toBeNull();
  });

  it("picks the oldest among multiple user keys (newer key first, older second)", () => {
    const a = auditServiceAccount(
      baseSa({
        keys: [
          { id: "1", key_type: "USER_MANAGED", valid_after: "2026-05-01T00:00:00Z" }, // 21 日前
          { id: "2", key_type: "USER_MANAGED", valid_after: "2026-04-01T00:00:00Z" }, // 51 日前
        ],
      }),
      now,
    );
    expect(a.oldest_user_key_age_days).toBe(51);
  });

  it("keeps oldest when later key is newer (covers || right branch = ageDays not greater)", () => {
    const a = auditServiceAccount(
      baseSa({
        keys: [
          { id: "1", key_type: "USER_MANAGED", valid_after: "2026-04-01T00:00:00Z" }, // 51 日前
          { id: "2", key_type: "USER_MANAGED", valid_after: "2026-05-01T00:00:00Z" }, // 21 日前
        ],
      }),
      now,
    );
    // 1 番目 (oldest=51) で確定、2 番目は 21 < 51 で更新なし
    expect(a.oldest_user_key_age_days).toBe(51);
  });

  it("uses new Date() by default", () => {
    const a = auditServiceAccount(baseSa());
    expect(a.status).toBe("ok");
  });

  it("combines multiple flags + candidate beats warn", () => {
    const a = auditServiceAccount(
      baseSa({
        disabled: true,
        roles: [],
        email: "x-compute@developer.gserviceaccount.com",
      }),
      now,
    );
    expect(a.flags).toEqual(
      expect.arrayContaining(["disabled", "no-role", "default-sa"]),
    );
    expect(a.status).toBe("candidate");
  });
});

describe("deriveStatus", () => {
  it("ok when no flags", () => {
    expect(deriveStatus([])).toBe("ok");
  });
  it("warn when only soft flags", () => {
    expect(deriveStatus(["key-old"])).toBe("warn");
    expect(deriveStatus(["default-sa", "key-anomaly"])).toBe("warn");
  });
  it("candidate when no-role or disabled", () => {
    expect(deriveStatus(["no-role"])).toBe("candidate");
    expect(deriveStatus(["disabled"])).toBe("candidate");
    expect(deriveStatus(["disabled", "key-old"])).toBe("candidate");
  });
});

describe("isDefaultSa", () => {
  it("matches compute default", () => {
    expect(isDefaultSa("9876-compute@developer.gserviceaccount.com")).toBe(true);
  });
  it("matches appspot default", () => {
    expect(isDefaultSa("foo@appspot.gserviceaccount.com")).toBe(true);
  });
  it("rejects regular SA", () => {
    expect(isDefaultSa("sa-a@p.iam.gserviceaccount.com")).toBe(false);
  });
  it("rejects bare email", () => {
    expect(isDefaultSa("user@example.com")).toBe(false);
  });
});

describe("summarize", () => {
  it("counts each status bucket", () => {
    const s = summarize([
      { status: "ok" },
      { status: "ok" },
      { status: "warn" },
      { status: "candidate" },
      { status: "candidate" },
      { status: "candidate" },
    ]);
    expect(s).toEqual({ total: 6, ok: 2, warn: 1, candidate: 3 });
  });
  it("handles empty input", () => {
    expect(summarize([])).toEqual({ total: 0, ok: 0, warn: 0, candidate: 0 });
  });
});
