import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { bindingJwtMiddleware } from "../../src/middleware/binding-jwt";
import type { Env, AppVariables } from "../../src/types";
import { makeTestEnv, mockIntrospectFetch } from "../helpers/env";

const TOKEN = "header.payload.sig";

function buildApp(introspectFetch?: typeof fetch) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("/protected", bindingJwtMiddleware({ introspectFetch }));
  app.get("/protected", (c) => c.json({ ok: true }));
  return app;
}

describe("bindingJwtMiddleware (rotate-mcp)", () => {
  it("401 + WWW-Authenticate when Authorization missing", async () => {
    const app = buildApp(mockIntrospectFetch({ expectedToken: TOKEN }));
    const res = await app.request("/protected", { method: "GET" }, makeTestEnv());
    expect(res.status).toBe(401);
    const www = res.headers.get("WWW-Authenticate");
    expect(www).toContain('Bearer realm="MCP"');
    expect(www).toContain('resource_metadata="https://auth.invalid/.well-known/oauth-protected-resource"');
  });

  it("401 when scheme is not Bearer", async () => {
    const app = buildApp(mockIntrospectFetch({ expectedToken: TOKEN }));
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: "Basic abc" } },
      makeTestEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("401 when introspect returns active:false (wrong token)", async () => {
    const app = buildApp(mockIntrospectFetch({ expectedToken: TOKEN }));
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: "Bearer different-token" } },
      makeTestEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("200 + sets bindingJwt + bearerVerified on valid token", async () => {
    let captured: Record<string, unknown> = {};
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use(
      "/protected",
      bindingJwtMiddleware({
        introspectFetch: mockIntrospectFetch({
          expectedToken: TOKEN,
          active: { sub: "user:99", github_login: "alice", scope: "mcp.write" },
        }),
      }),
    );
    app.get("/protected", (c) => {
      captured = {
        bindingJwt: c.get("bindingJwt"),
        bearerVerified: c.get("bearerVerified"),
      };
      return c.json({ ok: true });
    });

    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
      makeTestEnv(),
    );
    expect(res.status).toBe(200);
    expect(captured.bearerVerified).toBe(true);
    expect(captured.bindingJwt).toMatchObject({
      sub: "user:99",
      github_login: "alice",
      scope: "mcp.write",
    });
  });

  it("503 when introspect returns 503", async () => {
    const app = buildApp(
      mockIntrospectFetch({
        expectedToken: TOKEN,
        forceStatus: 503,
        forceBody: { active: false, error: "server_error" },
      }),
    );
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
      makeTestEnv(),
    );
    expect(res.status).toBe(503);
  });

  it("503 when fetch throws", async () => {
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const app = buildApp(throwing);
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
      makeTestEnv(),
    );
    expect(res.status).toBe(503);
  });

  it("503 when introspect returns 500", async () => {
    const app = buildApp(
      mockIntrospectFetch({ expectedToken: TOKEN, forceStatus: 500 }),
    );
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
      makeTestEnv(),
    );
    expect(res.status).toBe(503);
  });

  it("503 when introspect returns malformed JSON", async () => {
    const malformed = (async () =>
      new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })) as unknown as typeof fetch;
    const app = buildApp(malformed);
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
      makeTestEnv(),
    );
    expect(res.status).toBe(503);
  });

  it("503 when active:true but missing claims", async () => {
    const partial = (async () =>
      new Response(JSON.stringify({ active: true, sub: "u" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const app = buildApp(partial);
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
      makeTestEnv(),
    );
    expect(res.status).toBe(503);
  });

  it("401 when expectedAud allowlist excludes the claim aud", async () => {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use(
      "/protected",
      bindingJwtMiddleware({
        expectedAud: ["secrets-rotate-mcp"],
        introspectFetch: mockIntrospectFetch({
          expectedToken: TOKEN,
          active: { aud: "github-mcp-server-rs" },
        }),
      }),
    );
    app.get("/protected", (c) => c.json({ ok: true }));
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
      makeTestEnv(),
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

    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("/protected", bindingJwtMiddleware({ introspectFetch: sniffing }));
    app.get("/protected", (c) => c.json({ ok: true }));

    const env = makeTestEnv({ AUTH_WORKER_ORIGIN: "https://custom.example.invalid" });
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(calledUrl).toBe("https://custom.example.invalid/mcp/introspect");
  });

  it("does not echo the provided token in error responses", async () => {
    const app = buildApp(mockIntrospectFetch({ expectedToken: TOKEN }));
    const guess = "GUESSED-XXX-YYY";
    const res = await app.request(
      "/protected",
      { method: "GET", headers: { Authorization: `Bearer ${guess}` } },
      makeTestEnv(),
    );
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(guess);
  });
});
