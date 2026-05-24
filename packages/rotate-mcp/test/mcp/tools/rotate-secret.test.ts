import { describe, it, expect } from "vitest";
import {
  rotateSecretTool,
  dryRunRotateTool,
  validateRotateSecretArgs,
  executeRotateSecretMock,
  validationError,
} from "../../../src/mcp/tools/rotate-secret";

describe("rotate_secret tool schema", () => {
  it("exposes name + description + JSON schema", () => {
    expect(rotateSecretTool.name).toBe("rotate_secret");
    expect(rotateSecretTool.description).toMatch(/source of truth/);
    expect(rotateSecretTool.inputSchema.required).toEqual([
      "name",
      "new_value",
      "confirm_name",
    ]);
    // Phase B: SCREAMING_SNAKE + kebab-case 両許可 (= 親 repo
    // secrets.required の実運用 naming と一致)。
    expect(rotateSecretTool.inputSchema.properties.name.pattern).toBe(
      "^[A-Za-z][A-Za-z0-9_-]{0,127}$",
    );
  });

  it("dry_run_rotate exposes restricted schema", () => {
    expect(dryRunRotateTool.name).toBe("dry_run_rotate");
    expect(dryRunRotateTool.inputSchema.required).toEqual(["name"]);
  });
});

describe("validateRotateSecretArgs", () => {
  const valid = {
    name: "MY_SECRET",
    new_value: "v",
    confirm_name: "MY_SECRET",
  };

  it("accepts a minimal valid payload + applies default targets", () => {
    const r = validateRotateSecretArgs(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.targets).toEqual(["gcp", "cf", "github"]);
  });

  it("rejects non-object params", () => {
    expect(validateRotateSecretArgs(null).ok).toBe(false);
    expect(validateRotateSecretArgs("str").ok).toBe(false);
  });

  it("accepts kebab-case name (Phase B relaxation)", () => {
    // 親 repo secrets.required の実運用 naming (kebab-case) を rotate できる
    // ことを固定する。Phase A 以前は SCREAMING_SNAKE 専用だった。
    const r = validateRotateSecretArgs({
      ...valid,
      name: "cf-secrets-inventory-secrets-store-read",
      confirm_name: "cf-secrets-inventory-secrets-store-read",
    });
    expect(r.ok).toBe(true);
  });

  it("accepts lowercase name", () => {
    const r = validateRotateSecretArgs({
      ...valid,
      name: "my_secret",
      confirm_name: "my_secret",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects bad name pattern (starts with digit)", () => {
    const r = validateRotateSecretArgs({ ...valid, name: "1NAME" });
    expect(r.ok).toBe(false);
  });

  it("rejects bad name pattern (starts with underscore)", () => {
    const r = validateRotateSecretArgs({ ...valid, name: "_NAME" });
    expect(r.ok).toBe(false);
  });

  it("rejects bad name pattern (contains dot)", () => {
    const r = validateRotateSecretArgs({ ...valid, name: "foo.bar" });
    expect(r.ok).toBe(false);
  });

  it("rejects empty new_value", () => {
    const r = validateRotateSecretArgs({ ...valid, new_value: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects oversize new_value (>65536)", () => {
    const r = validateRotateSecretArgs({
      ...valid,
      new_value: "x".repeat(65537),
    });
    expect(r.ok).toBe(false);
  });

  it("rejects non-string new_value", () => {
    const r = validateRotateSecretArgs({ ...valid, new_value: 123 });
    expect(r.ok).toBe(false);
  });

  it("rejects non-string confirm_name", () => {
    const r = validateRotateSecretArgs({ ...valid, confirm_name: 1 });
    expect(r.ok).toBe(false);
  });

  it("rejects confirm_name mismatch", () => {
    const r = validateRotateSecretArgs({ ...valid, confirm_name: "OTHER" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // 値そのものはエラーメッセージに出さない (= brute force ヒント禁止)
    expect(r.error).not.toContain("MY_SECRET");
    expect(r.error).not.toContain("OTHER");
  });

  it("accepts custom targets", () => {
    const r = validateRotateSecretArgs({ ...valid, targets: ["gcp"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.targets).toEqual(["gcp"]);
  });

  it("rejects empty targets", () => {
    const r = validateRotateSecretArgs({ ...valid, targets: [] });
    expect(r.ok).toBe(false);
  });

  it("rejects non-array targets", () => {
    const r = validateRotateSecretArgs({ ...valid, targets: "gcp" });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown target enum", () => {
    const r = validateRotateSecretArgs({
      ...valid,
      targets: ["gcp", "azure"],
    });
    expect(r.ok).toBe(false);
  });

  it("accepts expected_gcp_version_id", () => {
    const r = validateRotateSecretArgs({
      ...valid,
      expected_gcp_version_id: "5",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.expected_gcp_version_id).toBe("5");
  });

  it("rejects non-string expected_gcp_version_id", () => {
    const r = validateRotateSecretArgs({
      ...valid,
      expected_gcp_version_id: 5,
    });
    expect(r.ok).toBe(false);
  });
});

describe("executeRotateSecretMock", () => {
  const baseArgs = {
    name: "MY_SECRET",
    new_value: "v",
    confirm_name: "MY_SECRET",
    targets: ["gcp", "cf", "github"] as const,
  };
  const fixedNow = () => new Date("2026-05-21T10:00:00.000Z");

  it("returns ok + mocked per-provider results", () => {
    const r = executeRotateSecretMock(
      { ...baseArgs, targets: [...baseArgs.targets] },
      { now: fixedNow },
    );
    expect(r.ok).toBe(true);
    expect(r.dry_run).toBe(false);
    expect(r.rotation_id).toMatch(/^rot_2026-05-21T10:00:00\.000Z_/);
    expect(r.results.gcp?.status).toBe("ok");
    expect(r.results.gcp?.new_version).toContain("MY_SECRET");
    expect(r.results.cf?.status).toBe("ok");
    expect(r.results.github?.status).toBe("ok");
  });

  it("never echoes new_value in result", () => {
    const r = executeRotateSecretMock(
      { ...baseArgs, new_value: "TOP-SECRET-VALUE", targets: [...baseArgs.targets] },
      { now: fixedNow },
    );
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("TOP-SECRET-VALUE");
  });

  it("dry_run returns skipped status per target", () => {
    const r = executeRotateSecretMock(
      { ...baseArgs, targets: [...baseArgs.targets] },
      { dryRun: true, now: fixedNow },
    );
    expect(r.dry_run).toBe(true);
    expect(r.results.gcp?.status).toBe("skipped");
    expect(r.results.cf?.status).toBe("skipped");
    expect(r.results.github?.status).toBe("skipped");
  });

  it("honors subset of targets", () => {
    const r = executeRotateSecretMock(
      { ...baseArgs, targets: ["gcp"] },
      { now: fixedNow },
    );
    expect(r.results.gcp?.status).toBe("ok");
    expect(r.results.cf).toBeUndefined();
    expect(r.results.github).toBeUndefined();
  });

  it("uses Date.now by default", () => {
    const r = executeRotateSecretMock({
      ...baseArgs,
      targets: [...baseArgs.targets],
    });
    expect(r.rotation_id.startsWith("rot_")).toBe(true);
  });
});

describe("validationError helper", () => {
  it("wraps message into JSON-RPC invalid_params", () => {
    const e = validationError(1, "bad");
    expect(e.error.code).toBe(-32602);
    expect(e.error.message).toBe("bad");
    expect(e.id).toBe(1);
  });
});
