import { describe, it, expect } from "vitest";
import { createApp } from "../src/index";
import defaultApp from "../src/index";
import { makeTestEnv, mockIntrospectFetch } from "./helpers/env";

// Refs #43: CF Access (Google OAuth) middleware を `/mcp*` から外し、
// auth-worker の `binding_jwt` (POST /mcp/introspect Mode 1) で一段認証に
// 変更したため、本 integration test は JWT sign / JWKS stub を持たない。
// `introspectFetch` だけ stub すれば middleware は完結する。

const TOKEN = "header.payload.sig";

function buildApp() {
  return createApp({
    introspectFetch: mockIntrospectFetch({ expectedToken: TOKEN }),
  });
}

describe("/health", () => {
  it("returns server info without auth", async () => {
    const app = buildApp();
    const res = await app.request("/health", {}, makeTestEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      name: "secrets-rotate-mcp",
      version: "0.0.2",
      protocol: "2025-03-26",
    });
  });
});

describe("POST /mcp (Streamable HTTP)", () => {
  it("rejects with 401 + WWW-Authenticate when no Authorization header", async () => {
    const app = buildApp();
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      },
      makeTestEnv(),
    );
    expect(res.status).toBe(401);
    const www = res.headers.get("WWW-Authenticate");
    expect(www).toContain('Bearer realm="MCP"');
    expect(www).toContain('resource_metadata="https://auth.invalid/.well-known/oauth-protected-resource"');
  });

  it("rejects with 401 when bearer is wrong", async () => {
    const app = buildApp();
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      },
      makeTestEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("returns initialize result with valid binding_jwt", async () => {
    const app = buildApp();
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      },
      makeTestEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe("secrets-rotate-mcp");
  });

  it("returns 400 + parse_error on invalid JSON", async () => {
    const app = buildApp();
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: "{",
      },
      makeTestEnv(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("returns 202 for notification (no id)", async () => {
    const app = buildApp();
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
      },
      makeTestEnv(),
    );
    expect(res.status).toBe(202);
  });

  it("calls rotate_secret tool end-to-end and never leaks new_value", async () => {
    const app = buildApp();
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "rotate_secret",
            arguments: {
              name: "MY_SECRET",
              new_value: "TOP-SECRET-V",
              confirm_name: "MY_SECRET",
              targets: ["gcp"],
            },
          },
        }),
      },
      makeTestEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("TOP-SECRET-V");
  });
});

describe("GET /mcp/sse (Legacy SSE)", () => {
  it("returns SSE stream with endpoint event", async () => {
    const app = buildApp();
    const res = await app.request(
      "/mcp/sse",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      makeTestEnv(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("X-MCP-Session-Id")).toBeTruthy();
    const text = await res.text();
    expect(text).toMatch(/event: endpoint/);
    expect(text).toMatch(/data: \/mcp\/sse\/message\?session=/);
  });

  it("requires binding_jwt (401 without Authorization)", async () => {
    const app = buildApp();
    const res = await app.request("/mcp/sse", {}, makeTestEnv());
    expect(res.status).toBe(401);
  });
});

describe("POST /mcp/sse/message (Legacy SSE)", () => {
  it("handles JSON-RPC request and returns JSON response", async () => {
    const app = buildApp();
    const res = await app.request(
      "/mcp/sse/message",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      },
      makeTestEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.length).toBe(3);
  });

  it("returns 400 on parse error", async () => {
    const app = buildApp();
    const res = await app.request(
      "/mcp/sse/message",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: "{",
      },
      makeTestEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 202 on notification", async () => {
    const app = buildApp();
    const res = await app.request(
      "/mcp/sse/message",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
      },
      makeTestEnv(),
    );
    expect(res.status).toBe(202);
  });
});

describe("unknown /mcp/* path", () => {
  it("returns 404 (after auth)", async () => {
    const app = buildApp();
    const res = await app.request(
      "/mcp/nope",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      makeTestEnv(),
    );
    expect(res.status).toBe(404);
  });

  it("rejects unknown path with 401 when not authenticated", async () => {
    const app = buildApp();
    const res = await app.request("/mcp/nope", {}, makeTestEnv());
    expect(res.status).toBe(401);
  });
});

describe("default export", () => {
  it("is the production createApp() instance (introspect fetch runs against real fetch in prod)", async () => {
    // import 時点では fetch を起動しない (= /health は middleware を通らない)。
    const res = await defaultApp.request("/health", {}, makeTestEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
