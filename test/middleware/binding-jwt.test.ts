import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { bindingJwtMiddleware } from "../../src/middleware/binding-jwt";
import type { Env } from "../../src/types";
import { baseTestEnv, mockIntrospectFetch } from "../test-helpers";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.payload.sig"; // shape だけそれっぽい opaque

function env(overrides: Partial<Env> = {}): Env {
  return baseTestEnv({ SNAPSHOT_KV: {} as KVNamespace, ...overrides }) as Env;
}

function buildApp(introspectFetch?: typeof fetch) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/protected", bindingJwtMiddleware({ introspectFetch }));
  app.get("/protected", (c) => c.json({ ok: true }));
  return app;
}

describe("bindingJwtMiddleware", () => {
  it("401 + WWW-Authenticate when Authorization header is missing", async () => {
    const app = buildApp(
      mockIntrospectFetch({
        expectedToken: TOKEN,
        authWorkerOrigin: "https://auth.invalid",
      }),
    );
    const res = await app.request("/protected", { method: "GET" }, env());
    expect(res.status).toBe(401);
    const www = res.headers.get("WWW-Authenticate");
    expect(www).toContain('Bearer realm="MCP"');
    // Refs ippoan/auth-worker#195: per-resource metadata endpoint。本 worker
    // 専用 slug (`security-inventory`) を suffix に持つ URL を指す (= MCP relay
    // 用 base path を避けて aud mismatch を解消)。
    expect(www).toContain(
      'resource_metadata="https://auth.invalid/.well-known/oauth-protected-resource/security-inventory"',
    );
    // header 欠落は RFC 6750 的に request-shape の問題なので `invalid_request`
    // (lib 昇格時に正規化された semantics — Refs ippoan/mcp-cf-workers#46)。
    expect(www).toContain('error="invalid_request"');
  });

  it("401 when scheme is not Bearer", async () => {
    const app = buildApp(
      mockIntrospectFetch({
        expectedToken: TOKEN,
        authWorkerOrigin: "https://auth.invalid",
      }),
    );
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: "Basic abc" } },
      env(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer realm=");
  });

  it("401 when introspect returns active:false (wrong token)", async () => {
    const app = buildApp(
      mockIntrospectFetch({
        expectedToken: TOKEN,
        authWorkerOrigin: "https://auth.invalid",
      }),
    );
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: "Bearer different-token" } },
      env(),
    );
    // mockIntrospectFetch は不一致 token に対して 401 を返す
    expect(res.status).toBe(401);
  });

  it("200 + claims set when token is active", async () => {
    let captured: unknown = null;
    const app = new Hono<{ Bindings: Env }>();
    app.use(
      "/protected",
      bindingJwtMiddleware({
        introspectFetch: mockIntrospectFetch({
          expectedToken: TOKEN,
          authWorkerOrigin: "https://auth.invalid",
          active: { sub: "user:99", github_login: "alice", scope: "mcp.read" },
        }),
      }),
    );
    app.get("/protected", (c) => {
      captured = c.get("bindingJwt" as never);
      return c.json({ ok: true });
    });

    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(res.status).toBe(200);
    expect(captured).toMatchObject({
      sub: "user:99",
      github_login: "alice",
      scope: "mcp.read",
    });
  });

  it("503 when introspect returns 503 (auth-worker misconfigured)", async () => {
    const app = buildApp(
      mockIntrospectFetch({
        expectedToken: TOKEN,
        authWorkerOrigin: "https://auth.invalid",
        forceStatus: 503,
        forceBody: { active: false, error: "server_error" },
      }),
    );
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(res.status).toBe(503);
  });

  it("503 when fetch itself throws (network error)", async () => {
    const throwingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const app = buildApp(throwingFetch);
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("ECONNREFUSED");
  });

  it("503 when introspect returns non-401 / non-503 error", async () => {
    const app = buildApp(
      mockIntrospectFetch({
        expectedToken: TOKEN,
        authWorkerOrigin: "https://auth.invalid",
        forceStatus: 500,
      }),
    );
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(res.status).toBe(503);
  });

  it("503 when introspect returns active:true but missing required claims", async () => {
    const malformed = (async () =>
      new Response(JSON.stringify({ active: true, sub: "u" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const app = buildApp(malformed);
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(res.status).toBe(503);
  });

  it("503 when introspect returns invalid JSON", async () => {
    const badJson = (async () =>
      new Response("<html>500</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })) as unknown as typeof fetch;
    const app = buildApp(badJson);
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(res.status).toBe(503);
  });

  it("401 when expectedAud allowlist is set and aud does not match", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use(
      "/protected",
      bindingJwtMiddleware({
        expectedAud: ["secrets-inventory-mcp"],
        introspectFetch: mockIntrospectFetch({
          expectedToken: TOKEN,
          authWorkerOrigin: "https://auth.invalid",
          active: { aud: "github-mcp-server-rs" },
        }),
      }),
    );
    app.get("/protected", (c) => c.json({ ok: true }));

    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
      env(),
    );
    expect(res.status).toBe(401);
  });

  it("uses env.AUTH_WORKER_ORIGIN when authWorkerOrigin option not given", async () => {
    let calledUrl = "";
    const sniffing = (async (input: RequestInfo | URL) => {
      calledUrl = typeof input === "string" ? input : input.toString();
      return new Response(
        JSON.stringify({
          active: true,
          sub: "u",
          github_login: "g",
          scope: "s",
          exp: Math.floor(Date.now() / 1000) + 60,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const app = new Hono<{ Bindings: Env }>();
    app.use("/protected", bindingJwtMiddleware({ introspectFetch: sniffing }));
    app.get("/protected", (c) => c.json({ ok: true }));

    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
      env({ AUTH_WORKER_ORIGIN: "https://custom.example.invalid" }),
    );
    expect(res.status).toBe(200);
    expect(calledUrl).toBe("https://custom.example.invalid/mcp/introspect");
  });

  it("never echoes the provided token in error responses", async () => {
    const app = buildApp(
      mockIntrospectFetch({
        expectedToken: TOKEN,
        authWorkerOrigin: "https://auth.invalid",
      }),
    );
    const secretAttempt = "GUESSED-SECRET-VALUE-XYZ";
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: `Bearer ${secretAttempt}` } },
      env(),
    );
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(secretAttempt);
  });
});
