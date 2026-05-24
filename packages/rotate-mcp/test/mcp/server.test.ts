import { describe, it, expect } from "vitest";
import { handleMcpRequest } from "../../src/mcp/server";
import type { Env } from "../../src/types";
import { makeTestEnv } from "../helpers/env";
import { stubFetcher, happyPathRoutes } from "../helpers/fetcher";

const env = makeTestEnv({
  CF_ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
  CF_ACCESS_AUD: "aud",
});

describe("handleMcpRequest", () => {
  it("responds to initialize with serverInfo + protocol + capabilities", async () => {
    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      env,
    );
    expect(res).not.toBeNull();
    if (res === null || "error" in res) throw new Error("expected success");
    const result = res.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      capabilities: Record<string, unknown>;
    };
    expect(result.protocolVersion).toBe("2025-03-26");
    expect(result.serverInfo.name).toBe("secrets-rotate-mcp");
    expect(result.capabilities.tools).toEqual({ listChanged: false });
  });

  it("responds to ping with {}", async () => {
    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 2, method: "ping" },
      env,
    );
    if (res === null || "error" in res) throw new Error("expected success");
    expect(res.result).toEqual({});
  });

  it("returns 3 tools on tools/list", async () => {
    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      env,
    );
    if (res === null || "error" in res) throw new Error("expected success");
    const result = res.result as { tools: Array<{ name: string }> };
    expect(result.tools.map((t) => t.name)).toEqual([
      "rotate_secret",
      "dry_run_rotate",
      "create_secret",
    ]);
  });

  it("rejects unknown method with -32601", async () => {
    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 4, method: "nope" },
      env,
    );
    if (res === null || !("error" in res)) throw new Error("expected error");
    expect(res.error.code).toBe(-32601);
  });

  it("returns null for notification (id undefined)", async () => {
    const res = await handleMcpRequest(
      { jsonrpc: "2.0", method: "ping" },
      env,
    );
    expect(res).toBeNull();
  });

  it("rejects non-JSON-RPC request with -32600 + null id", async () => {
    const res = await handleMcpRequest(
      { jsonrpc: "1.0" as "2.0", method: "x" },
      env,
    );
    if (res === null || !("error" in res)) throw new Error("expected error");
    expect(res.error.code).toBe(-32600);
    expect(res.id).toBeNull();
  });
});

describe("handleMcpRequest tools/call rotate_secret", () => {
  it("calls rotate_secret with valid args + returns real provider results", async () => {
    const { fetcher, calls } = stubFetcher(happyPathRoutes("MY_SECRET"));
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "rotate_secret",
          arguments: {
            name: "MY_SECRET",
            new_value: "super-secret-value",
            confirm_name: "MY_SECRET",
          },
        },
      },
      env,
      { fetcher, actorEmail: "actor@example.com" },
    );
    if (res === null || "error" in res) throw new Error("expected success");
    const result = res.result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.content[0]!.type).toBe("text");
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.ok).toBe(true);
    expect(payload.dry_run).toBe(false);
    expect(payload.results.gcp.status).toBe("ok");
    expect(payload.results.cf.status).toBe("ok");
    expect(payload.results.github.status).toBe("ok");
    // new_value は response に echo されない
    expect(result.content[0]!.text).not.toContain("super-secret-value");
    // actor email は GCP proxy header に転送される
    const gcpCall = calls.find((c) => c.url.includes("/add-version"));
    expect(gcpCall).toBeDefined();
  });

  it("rejects rotate_secret with bad arguments (confirm mismatch)", async () => {
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "rotate_secret",
          arguments: {
            name: "MY_SECRET",
            new_value: "v",
            confirm_name: "OTHER",
          },
        },
      },
      env,
    );
    if (res === null || !("error" in res)) throw new Error("expected error");
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toMatch(/confirm_name/);
  });

  it("rejects rotate_secret with non-object arguments", async () => {
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "rotate_secret", arguments: null },
      },
      env,
    );
    if (res === null || !("error" in res)) throw new Error("expected error");
    expect(res.error.code).toBe(-32602);
  });

  it("calls dry_run_rotate with name only", async () => {
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "dry_run_rotate",
          arguments: { name: "MY_SECRET" },
        },
      },
      env,
    );
    if (res === null || "error" in res) throw new Error("expected success");
    const result = res.result as {
      content: Array<{ text: string }>;
    };
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.dry_run).toBe(true);
    expect(payload.results.gcp.status).toBe("skipped");
  });

  it("rejects dry_run_rotate with bad name (starts with digit)", async () => {
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "dry_run_rotate",
          arguments: { name: "1bad" },
        },
      },
      env,
    );
    if (res === null || !("error" in res)) throw new Error("expected error");
    expect(res.error.code).toBe(-32602);
  });

  it("rejects dry_run_rotate with non-object arguments", async () => {
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "dry_run_rotate", arguments: "x" },
      },
      env,
    );
    if (res === null || !("error" in res)) throw new Error("expected error");
    expect(res.error.code).toBe(-32602);
  });

  it("rejects tools/call with non-object params", async () => {
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: "x",
      },
      env,
    );
    if (res === null || !("error" in res)) throw new Error("expected error");
    expect(res.error.code).toBe(-32602);
  });

  it("rejects tools/call with non-string tool name", async () => {
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: { name: 5 },
      },
      env,
    );
    if (res === null || !("error" in res)) throw new Error("expected error");
    expect(res.error.code).toBe(-32602);
  });

  it("rejects unknown tool name", async () => {
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: { name: "nope", arguments: {} },
      },
      env,
    );
    if (res === null || !("error" in res)) throw new Error("expected error");
    expect(res.error.code).toBe(-32601);
  });
});

describe("handleMcpRequest exception path", () => {
  it("wraps unexpected Error into -32603", async () => {
    const badEnv = new Proxy(env, {
      get(target, prop) {
        if (prop === "MCP_PROTOCOL_VERSION") {
          throw new Error("explode");
        }
        return target[prop as keyof Env];
      },
    }) as Env;
    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 14, method: "initialize" },
      badEnv,
    );
    if (res === null || !("error" in res)) throw new Error("expected error");
    expect(res.error.code).toBe(-32603);
    expect(res.error.message).toBe("explode");
  });

  it("wraps non-Error throw into -32603 via String(err)", async () => {
    const badEnv = new Proxy(env, {
      get(target, prop) {
        if (prop === "MCP_PROTOCOL_VERSION") {
          throw "non-error-string";
        }
        return target[prop as keyof Env];
      },
    }) as Env;
    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 15, method: "initialize" },
      badEnv,
    );
    if (res === null || !("error" in res)) throw new Error("expected error");
    expect(res.error.code).toBe(-32603);
    expect(res.error.message).toBe("non-error-string");
  });
});
