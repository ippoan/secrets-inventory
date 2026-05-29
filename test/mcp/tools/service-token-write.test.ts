import { describe, it, expect, vi, afterEach } from "vitest";
import {
  rotateServiceTokenTool,
  deleteServiceTokenTool,
  rotateServiceTokenInputSchema,
  deleteServiceTokenInputSchema,
  createServiceTokenTool,
  createServiceTokenInputSchema,
  parseProtectedTokenIds,
} from "../../../src/mcp/tools/service-token-write";
import { baseTestEnv } from "../../test-helpers";
import type { Env } from "../../../src/types";

afterEach(() => {
  vi.restoreAllMocks();
});

const TOKEN_ID = "6553de0b-e1e1-4270-a65d-08bd69055044";

describe("service-token-write schemas", () => {
  it("rotate: accepts matching confirm + valid sm name", () => {
    const r = rotateServiceTokenInputSchema.safeParse({
      token_id: TOKEN_ID,
      sm_secret_name: "foo-client-secret",
      confirm_token_id: TOKEN_ID,
    });
    expect(r.success).toBe(true);
  });

  it("rotate: rejects confirm mismatch", () => {
    const r = rotateServiceTokenInputSchema.safeParse({
      token_id: TOKEN_ID,
      sm_secret_name: "foo",
      confirm_token_id: "different",
    });
    expect(r.success).toBe(false);
  });

  it("rotate: rejects invalid sm_secret_name", () => {
    const r = rotateServiceTokenInputSchema.safeParse({
      token_id: TOKEN_ID,
      sm_secret_name: "bad name!",
      confirm_token_id: TOKEN_ID,
    });
    expect(r.success).toBe(false);
  });

  it("rotate: rejects token_id with path injection", () => {
    const r = rotateServiceTokenInputSchema.safeParse({
      token_id: "a/b",
      sm_secret_name: "foo",
      confirm_token_id: "a/b",
    });
    expect(r.success).toBe(false);
  });

  it("delete: accepts matching confirm", () => {
    expect(
      deleteServiceTokenInputSchema.safeParse({
        token_id: TOKEN_ID,
        confirm_token_id: TOKEN_ID,
      }).success,
    ).toBe(true);
  });

  it("delete: rejects confirm mismatch", () => {
    expect(
      deleteServiceTokenInputSchema.safeParse({
        token_id: TOKEN_ID,
        confirm_token_id: "x",
      }).success,
    ).toBe(false);
  });

  it("delete: accepts optional sm_secret_name", () => {
    expect(
      deleteServiceTokenInputSchema.safeParse({
        token_id: TOKEN_ID,
        sm_secret_name: "foo-client-secret",
        confirm_token_id: TOKEN_ID,
      }).success,
    ).toBe(true);
  });

  it("delete: rejects invalid sm_secret_name", () => {
    expect(
      deleteServiceTokenInputSchema.safeParse({
        token_id: TOKEN_ID,
        sm_secret_name: "bad name!",
        confirm_token_id: TOKEN_ID,
      }).success,
    ).toBe(false);
  });
});

describe("parseProtectedTokenIds", () => {
  it("parses comma-separated list with trimming, ignores blanks", () => {
    const env = baseTestEnv({
      CF_SERVICE_TOKEN_PROTECTED_IDS: " st-a , st-b ,, st-c ",
    }) as Env;
    const set = parseProtectedTokenIds(env);
    expect([...set].sort()).toEqual(["st-a", "st-b", "st-c"]);
  });

  it("empty / unset → empty set", () => {
    expect(parseProtectedTokenIds(baseTestEnv() as Env).size).toBe(0);
    expect(
      parseProtectedTokenIds(baseTestEnv({ CF_SERVICE_TOKEN_PROTECTED_IDS: "" }) as Env).size,
    ).toBe(0);
  });
});

describe("rotate_service_token execute", () => {
  it("calls proxy rotate and returns metadata (no client_secret)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe(`https://gcp-stub.run.app/cf/service-tokens/${TOKEN_ID}/rotate`);
      expect(init?.method).toBe("POST");
      return Response.json({
        ok: true,
        token_id: TOKEN_ID,
        client_id: "abc.access",
        sm_secret_name: "foo-client-secret",
        sm_version: "projects/p/secrets/foo-client-secret/versions/1",
        created: true,
      });
    });
    const res = (await rotateServiceTokenTool.execute(baseTestEnv() as Env, {
      token_id: TOKEN_ID,
      sm_secret_name: "foo-client-secret",
      confirm_token_id: TOKEN_ID,
    })) as { status: string; token_id?: string };
    expect(res.status).toBe("ok");
    expect(res.token_id).toBe(TOKEN_ID);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(JSON.stringify(res)).not.toContain("client_secret\"");
  });

  it("refuses protected token id (suicide guard) without calling proxy", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const env = baseTestEnv({ CF_SERVICE_TOKEN_PROTECTED_IDS: TOKEN_ID }) as Env;
    const res = (await rotateServiceTokenTool.execute(env, {
      token_id: TOKEN_ID,
      sm_secret_name: "foo",
      confirm_token_id: TOKEN_ID,
    })) as { status: string; error?: string };
    expect(res.status).toBe("fail");
    expect(res.error).toMatch(/protected/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires mcp.write scope", () => {
    expect(rotateServiceTokenTool.requiresScope).toBe("mcp.write");
  });
});

describe("delete_service_token execute", () => {
  it("calls proxy delete and returns ok", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe(`https://gcp-stub.run.app/cf/service-tokens/${TOKEN_ID}`);
      expect(init?.method).toBe("DELETE");
      return Response.json({ ok: true, token_id: TOKEN_ID });
    });
    const res = (await deleteServiceTokenTool.execute(baseTestEnv() as Env, {
      token_id: TOKEN_ID,
      confirm_token_id: TOKEN_ID,
    })) as { status: string; token_id?: string };
    expect(res.status).toBe("ok");
    expect(res.token_id).toBe(TOKEN_ID);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("passes sm_secret_name as query and surfaces label_applied", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe(
        `https://gcp-stub.run.app/cf/service-tokens/${TOKEN_ID}?sm_secret_name=foo-client-secret`,
      );
      expect(init?.method).toBe("DELETE");
      return Response.json({
        ok: true,
        token_id: TOKEN_ID,
        sm_secret_name: "foo-client-secret",
        label_applied: true,
      });
    });
    const res = (await deleteServiceTokenTool.execute(baseTestEnv() as Env, {
      token_id: TOKEN_ID,
      sm_secret_name: "foo-client-secret",
      confirm_token_id: TOKEN_ID,
    })) as { status: string; label_applied?: boolean };
    expect(res.status).toBe("ok");
    expect(res.label_applied).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("refuses protected token id without calling proxy", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const env = baseTestEnv({ CF_SERVICE_TOKEN_PROTECTED_IDS: `other, ${TOKEN_ID}` }) as Env;
    const res = (await deleteServiceTokenTool.execute(env, {
      token_id: TOKEN_ID,
      confirm_token_id: TOKEN_ID,
    })) as { status: string; error?: string };
    expect(res.status).toBe("fail");
    expect(res.error).toMatch(/protected/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires mcp.write scope", () => {
    expect(deleteServiceTokenTool.requiresScope).toBe("mcp.write");
  });
});

describe("create_service_token", () => {
  it("schema: accepts convention-style name + sm name + duration", () => {
    const r = createServiceTokenInputSchema.safeParse({
      name: "ohishi-dtako-prod-api-202605",
      sm_secret_name: "dtako-api-client-secret",
      duration: "8760h",
    });
    expect(r.success).toBe(true);
  });

  it("schema: rejects name with spaces (convention enforce)", () => {
    expect(
      createServiceTokenInputSchema.safeParse({
        name: "bad name",
        sm_secret_name: "foo",
      }).success,
    ).toBe(false);
  });

  it("schema: rejects bad duration", () => {
    expect(
      createServiceTokenInputSchema.safeParse({
        name: "foo",
        sm_secret_name: "bar",
        duration: "forever",
      }).success,
    ).toBe(false);
  });

  it("execute: calls proxy create and returns metadata (no client_secret)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("https://gcp-stub.run.app/cf/service-tokens");
      expect(init?.method).toBe("POST");
      return Response.json({
        ok: true,
        token_id: "st-new",
        name: "ohishi-dtako-prod-api-202605",
        client_id: "new.access",
        sm_secret_name: "dtako-api-client-secret",
        sm_version: "projects/p/secrets/dtako-api-client-secret/versions/1",
        created: true,
      });
    });
    const res = (await createServiceTokenTool.execute(baseTestEnv() as Env, {
      name: "ohishi-dtako-prod-api-202605",
      sm_secret_name: "dtako-api-client-secret",
    })) as { status: string; token_id?: string; name?: string };
    expect(res.status).toBe("ok");
    expect(res.token_id).toBe("st-new");
    expect(res.name).toBe("ohishi-dtako-prod-api-202605");
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(JSON.stringify(res)).not.toContain("client_secret\"");
  });

  it("requires mcp.write scope", () => {
    expect(createServiceTokenTool.requiresScope).toBe("mcp.write");
  });
});
