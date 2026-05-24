import { describe, it, expect } from "vitest";
import {
  createSecretTool,
  validateCreateSecretArgs,
  executeCreateSecret,
} from "../../../src/mcp/tools/rotate-secret";
import { makeTestEnv } from "../../helpers/env";
import { stubFetcher, TEST_GH_PUBLIC_KEY_B64 } from "../../helpers/fetcher";

const validArgs = {
  name: "NEW_SECRET",
  initial_value: "secret-payload",
  confirm_name: "NEW_SECRET",
};

describe("create_secret tool schema", () => {
  it("exposes name + initial_value + confirm_name required", () => {
    expect(createSecretTool.name).toBe("create_secret");
    expect(createSecretTool.inputSchema.required).toEqual([
      "name",
      "initial_value",
      "confirm_name",
    ]);
    expect(createSecretTool.inputSchema.properties.fail_if_exists.default).toBe(true);
  });
});

describe("validateCreateSecretArgs", () => {
  it("accepts valid args", () => {
    const r = validateCreateSecretArgs(validArgs);
    expect(r.ok).toBe(true);
  });

  it("rejects non-object params", () => {
    expect(validateCreateSecretArgs(null).ok).toBe(false);
    expect(validateCreateSecretArgs(42).ok).toBe(false);
  });

  it("rejects missing initial_value", () => {
    const r = validateCreateSecretArgs({ ...validArgs, initial_value: undefined });
    expect(r.ok).toBe(false);
  });

  it("rejects empty initial_value", () => {
    const r = validateCreateSecretArgs({ ...validArgs, initial_value: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects oversize initial_value (>65536)", () => {
    const r = validateCreateSecretArgs({
      ...validArgs,
      initial_value: "x".repeat(65537),
    });
    expect(r.ok).toBe(false);
  });

  it("rejects confirm_name mismatch", () => {
    const r = validateCreateSecretArgs({ ...validArgs, confirm_name: "OTHER" });
    expect(r.ok).toBe(false);
  });

  it("rejects bad name pattern", () => {
    const r = validateCreateSecretArgs({ ...validArgs, name: "1bad", confirm_name: "1bad" });
    expect(r.ok).toBe(false);
  });

  it("rejects empty targets array", () => {
    const r = validateCreateSecretArgs({ ...validArgs, targets: [] });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown target", () => {
    const r = validateCreateSecretArgs({ ...validArgs, targets: ["gcp", "unknown"] });
    expect(r.ok).toBe(false);
  });

  it("rejects non-boolean fail_if_exists", () => {
    const r = validateCreateSecretArgs({ ...validArgs, fail_if_exists: "true" });
    expect(r.ok).toBe(false);
  });

  it("defaults fail_if_exists to true", () => {
    const r = validateCreateSecretArgs(validArgs);
    if (!r.ok) throw new Error("expected ok");
    expect(r.args.fail_if_exists).toBe(true);
  });

  it("rejects non-string cf_scopes", () => {
    const r = validateCreateSecretArgs({ ...validArgs, cf_scopes: [1, 2] });
    expect(r.ok).toBe(false);
  });

  it("accepts cf_scopes when provided", () => {
    const r = validateCreateSecretArgs({ ...validArgs, cf_scopes: ["workers", "pages"] });
    if (!r.ok) throw new Error("expected ok");
    expect(r.args.cf_scopes).toEqual(["workers", "pages"]);
  });
});

describe("executeCreateSecret", () => {
  it("3 providers all create OK → ok=true, all created=true", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      {
        method: "POST",
        match: "/create-secret",
        body: { ok: true, name: "NEW_SECRET", created: true, new_version: "p/secrets/NEW_SECRET/versions/1" },
      },
      { method: "GET", match: "/secrets_store/stores/", body: { success: true, result: [] } },
      { method: "POST", match: "/secrets_store/stores/", body: { success: true, result: { id: "cf-new", name: "NEW_SECRET" } } },
      { method: "GET", match: "/actions/secrets/NEW_SECRET", body: { message: "nf" }, status: 404 },
      { method: "GET", match: "/actions/secrets/public-key", body: { key_id: "kid", key: TEST_GH_PUBLIC_KEY_B64 } },
      { method: "PUT", match: "/actions/secrets/", status: 201 },
    ]);
    const r = await executeCreateSecret(
      { ...validArgs, targets: ["gcp", "cf", "github"], fail_if_exists: true },
      env,
      { fetcher },
    );
    expect(r.ok).toBe(true);
    expect(r.rotation_id).toMatch(/^crt_/);
    expect(r.results.gcp?.status).toBe("ok");
    expect(r.results.cf?.status).toBe("ok");
    expect(r.results.github?.status).toBe("ok");
  });

  it("partial failure: cf exists → ok=false, gcp/github 結果は残る", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      {
        method: "POST",
        match: "/create-secret",
        body: { ok: true, name: "X", created: true, new_version: "p/secrets/X/versions/1" },
      },
      // CF: 既存 → fail_if_exists=true で fail
      {
        method: "GET",
        match: "/secrets_store/stores/",
        body: { success: true, result: [{ id: "existing", name: "X" }] },
      },
      { method: "GET", match: "/actions/secrets/X", body: { message: "nf" }, status: 404 },
      { method: "GET", match: "/actions/secrets/public-key", body: { key_id: "kid", key: TEST_GH_PUBLIC_KEY_B64 } },
      { method: "PUT", match: "/actions/secrets/", status: 201 },
    ]);
    const r = await executeCreateSecret(
      {
        name: "X",
        initial_value: "v",
        confirm_name: "X",
        targets: ["gcp", "cf", "github"],
        fail_if_exists: true,
      },
      env,
      { fetcher },
    );
    expect(r.ok).toBe(false);
    expect(r.results.gcp?.status).toBe("ok");
    expect(r.results.cf?.status).toBe("fail");
    expect(r.results.github?.status).toBe("ok");
  });

  it("targets 部分集合: github のみ create", async () => {
    const env = makeTestEnv();
    const { fetcher, calls } = stubFetcher([
      { method: "GET", match: "/actions/secrets/X", body: { message: "nf" }, status: 404 },
      { method: "GET", match: "/actions/secrets/public-key", body: { key_id: "kid", key: TEST_GH_PUBLIC_KEY_B64 } },
      { method: "PUT", match: "/actions/secrets/", status: 201 },
    ]);
    const r = await executeCreateSecret(
      {
        name: "X",
        initial_value: "v",
        confirm_name: "X",
        targets: ["github"],
        fail_if_exists: true,
      },
      env,
      { fetcher },
    );
    expect(r.ok).toBe(true);
    expect(r.results.gcp).toBeUndefined();
    expect(r.results.cf).toBeUndefined();
    expect(r.results.github?.status).toBe("ok");
    // GCP / CF endpoint には触っていない
    expect(calls.find((c) => c.url.includes("/create-secret"))).toBeUndefined();
    expect(calls.find((c) => c.url.includes("/secrets_store/"))).toBeUndefined();
  });

  it("initial_value は result JSON に echo されない", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      {
        method: "POST",
        match: "/create-secret",
        body: { ok: true, name: "X", created: true, new_version: "p/secrets/X/versions/1" },
      },
    ]);
    const r = await executeCreateSecret(
      {
        name: "X",
        initial_value: "UNIQUE_INITIAL_VALUE_QQQQ",
        confirm_name: "X",
        targets: ["gcp"],
        fail_if_exists: true,
      },
      env,
      { fetcher },
    );
    expect(JSON.stringify(r)).not.toContain("UNIQUE_INITIAL_VALUE_QQQQ");
  });
});
