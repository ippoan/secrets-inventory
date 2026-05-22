import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import {
  streamableHttpPost,
  legacySseGet,
  legacySsePost,
} from "../../src/mcp/http-handler";
import type { Env } from "../../src/types";
import { baseTestEnv } from "../test-helpers";

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.post("/mcp", streamableHttpPost);
  app.get("/mcp/sse", legacySseGet);
  app.post("/mcp/sse/message", legacySsePost);
  return app;
}

function env(): Env {
  const kv: KVNamespace = {
    get: async () => null,
  } as unknown as KVNamespace;
  return baseTestEnv({ SNAPSHOT_KV: kv }) as Env;
}

describe("MCP http-handler", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ secrets: [] }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("POST /mcp (streamable HTTP)", () => {
    it("returns 200 + JSON-RPC response for a request", async () => {
      const app = buildApp();
      const res = await app.request(
        "/mcp",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
          }),
        },
        env(),
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        jsonrpc: string;
        id: number;
        result: { tools: Array<{ name: string }> };
      }>();
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe(1);
      expect(body.result.tools.length).toBeGreaterThan(0);
    });

    it("returns 202 with empty body for a notification (no id)", async () => {
      const app = buildApp();
      const res = await app.request(
        "/mcp",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }),
        },
        env(),
      );
      expect(res.status).toBe(202);
      expect(await res.text()).toBe("");
    });

    it("returns 400 with JSON-RPC parse error on malformed body", async () => {
      const app = buildApp();
      const res = await app.request(
        "/mcp",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{ not json",
        },
        env(),
      );
      expect(res.status).toBe(400);
      const body = await res.json<{
        jsonrpc: string;
        error: { code: number; message: string };
      }>();
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error.code).toBe(-32700);
    });
  });

  describe("GET /mcp/sse (legacy SSE)", () => {
    it("returns text/event-stream with endpoint event + session id header", async () => {
      const app = buildApp();
      const res = await app.request("/mcp/sse", { method: "GET" }, env());
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      const sessionId = res.headers.get("X-MCP-Session-Id");
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/i);
      const text = await res.text();
      expect(text).toContain("event: endpoint");
      expect(text).toContain(`/mcp/sse/message?session=${sessionId}`);
    });
  });

  describe("POST /mcp/sse/message (legacy SSE ingest)", () => {
    it("processes request like streamable HTTP and returns 200 JSON", async () => {
      const app = buildApp();
      const res = await app.request(
        "/mcp/sse/message",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            method: "tools/list",
          }),
        },
        env(),
      );
      expect(res.status).toBe(200);
      const body = await res.json<{ id: number; result: unknown }>();
      expect(body.id).toBe(7);
      expect(body.result).toBeDefined();
    });
  });
});
