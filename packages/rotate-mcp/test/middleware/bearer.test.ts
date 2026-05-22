import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { bearerMiddleware } from "../../src/middleware/bearer";
import type { Env, AppVariables, SecretsStoreSecret } from "../../src/types";

const baseEnv: Env = {
  CF_ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
  CF_ACCESS_AUD: "aud",
  MCP_SERVER_NAME: "secrets-rotate-mcp",
  MCP_SERVER_VERSION: "0.0.1",
  MCP_PROTOCOL_VERSION: "2025-03-26",
  ROTATE_MCP_BEARER: mockSecret("sekret-value"),
};

function mockSecret(value: string): SecretsStoreSecret {
  return {
    get: async () => value,
  };
}

function buildApp(envOverride?: Partial<Env>) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("/mcp/*", bearerMiddleware());
  app.get("/mcp/ok", (c) =>
    c.json({ verified: c.get("bearerVerified") === true }),
  );
  return {
    app,
    env: { ...baseEnv, ...(envOverride ?? {}) },
  };
}

describe("bearerMiddleware", () => {
  it("rejects when Authorization header is absent", async () => {
    const { app, env } = buildApp();
    const res = await app.request("/mcp/ok", {}, env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/missing or malformed/);
  });

  it("rejects when scheme is not Bearer", async () => {
    const { app, env } = buildApp();
    const res = await app.request(
      "/mcp/ok",
      { headers: { Authorization: "Basic abc" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects empty bearer token (Bearer scheme without value)", async () => {
    // Hono / fetch API は header value を trim するため、`Authorization: Bearer `
    // は `Bearer` として届く。`Bearer ` (末尾 space あり) との prefix match に
    // 失敗するので "missing or malformed" path で 401。Bearer scheme 単独は
    // value 不在として全部ここで 401。
    const { app, env } = buildApp();
    const res = await app.request(
      "/mcp/ok",
      { headers: { Authorization: "Bearer" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns 503 when binding is missing", async () => {
    const { app, env } = buildApp({
      ROTATE_MCP_BEARER: undefined as unknown as SecretsStoreSecret,
    });
    const res = await app.request(
      "/mcp/ok",
      { headers: { Authorization: "Bearer x" } },
      env,
    );
    expect(res.status).toBe(503);
  });

  it("returns 503 when binding.get throws (Error)", async () => {
    const { app, env } = buildApp({
      ROTATE_MCP_BEARER: {
        get: async () => {
          throw new Error("binding read fail");
        },
      },
    });
    const res = await app.request(
      "/mcp/ok",
      { headers: { Authorization: "Bearer x" } },
      env,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Bearer secret read failed: binding read fail/);
  });

  it("returns 503 when binding.get throws (non-Error)", async () => {
    const { app, env } = buildApp({
      ROTATE_MCP_BEARER: {
        get: async () => {
          throw "non-error-string";
        },
      },
    });
    const res = await app.request(
      "/mcp/ok",
      { headers: { Authorization: "Bearer x" } },
      env,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Bearer secret read failed: non-error-string/);
  });

  it("returns 503 when bearer is empty string in store", async () => {
    const { app, env } = buildApp({
      ROTATE_MCP_BEARER: mockSecret(""),
    });
    const res = await app.request(
      "/mcp/ok",
      { headers: { Authorization: "Bearer x" } },
      env,
    );
    expect(res.status).toBe(503);
  });

  it("rejects mismatched bearer", async () => {
    const { app, env } = buildApp();
    const res = await app.request(
      "/mcp/ok",
      { headers: { Authorization: "Bearer wrong" } },
      env,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid bearer/);
  });

  it("passes through with matching bearer", async () => {
    const { app, env } = buildApp();
    const res = await app.request(
      "/mcp/ok",
      { headers: { Authorization: "Bearer sekret-value" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: true });
  });

  it("constant-time check ignores length differences without throwing", async () => {
    // 値の length が異なる token は内部で SHA-256 後比較されるため、観測される
    // status code は通常の mismatch と同じ 401。timing leak が無いことは形式的
    // には ensure できないので動作確認のみ。
    const { app, env } = buildApp();
    const res = await app.request(
      "/mcp/ok",
      {
        headers: {
          Authorization: "Bearer " + "x".repeat(4096),
        },
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("accepts options.expectedBearer override", async () => {
    const override = mockSecret("override-value");
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("/mcp/*", bearerMiddleware({ expectedBearer: override }));
    app.get("/mcp/ok", (c) => c.json({ ok: true }));
    const res = await app.request(
      "/mcp/ok",
      { headers: { Authorization: "Bearer override-value" } },
      baseEnv,
    );
    expect(res.status).toBe(200);
  });
});
