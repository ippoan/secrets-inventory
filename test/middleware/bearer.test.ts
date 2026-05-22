import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { bearerMiddleware } from "../../src/middleware/bearer";
import type { Env } from "../../src/types";
import { baseTestEnv, mockSecret } from "../test-helpers";

function buildApp(bearer?: SecretsStoreSecret) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/protected", bearerMiddleware({ expectedBearer: bearer }));
  app.get("/protected", (c) => c.json({ ok: true }));
  return app;
}

function env(overrides: Partial<Env> = {}): Env {
  return baseTestEnv({ SNAPSHOT_KV: {} as KVNamespace, ...overrides }) as Env;
}

describe("bearerMiddleware", () => {
  it("401 when Authorization header is missing", async () => {
    const app = buildApp(mockSecret("expected"));
    const res = await app.request("/protected", { method: "GET" }, env());
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("missing or malformed");
  });

  it("401 when scheme is not Bearer", async () => {
    const app = buildApp(mockSecret("expected"));
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: "Basic abc" } },
      env(),
    );
    expect(res.status).toBe(401);
  });

  it("401 when token does not match", async () => {
    const app = buildApp(mockSecret("expected"));
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: "Bearer wrong" } },
      env(),
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("invalid bearer token");
  });

  it("200 when token matches (via expectedBearer override)", async () => {
    const app = buildApp(mockSecret("expected"));
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: "Bearer expected" } },
      env(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("200 when token matches (via env binding fallback)", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("/protected", bearerMiddleware());
    app.get("/protected", (c) => c.json({ ok: true }));

    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: "Bearer test-bearer" } },
      env(), // baseTestEnv は INVENTORY_MCP_BEARER に "test-bearer" を入れている
    );
    expect(res.status).toBe(200);
  });

  it("503 when Secrets Store binding is missing", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("/protected", bearerMiddleware());
    app.get("/protected", (c) => c.json({ ok: true }));

    // INVENTORY_MCP_BEARER を undefined にする
    const e = env({ INVENTORY_MCP_BEARER: undefined as unknown as SecretsStoreSecret });
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: "Bearer anything" } },
      e,
    );
    expect(res.status).toBe(503);
  });

  it("503 when Secrets Store .get() throws", async () => {
    const throwing: SecretsStoreSecret = {
      async get() {
        throw new Error("vault unreachable");
      },
    } as unknown as SecretsStoreSecret;
    const app = buildApp(throwing);
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: "Bearer anything" } },
      env(),
    );
    expect(res.status).toBe(503);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("vault unreachable");
  });

  it("503 when expected bearer is empty string (= not provisioned)", async () => {
    const app = buildApp(mockSecret(""));
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: "Bearer anything" } },
      env(),
    );
    expect(res.status).toBe(503);
  });

  it("never echoes the provided token in error responses", async () => {
    const app = buildApp(mockSecret("expected"));
    const secretAttempt = "GUESSED-SECRET-VALUE-XYZ";
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: `Bearer ${secretAttempt}` } },
      env(),
    );
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(secretAttempt);
    expect(text).not.toContain("expected");
  });
});
