import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createMcpServer } from "../../src/mcp/server";
import { WorkerTransport } from "../../src/mcp/transport";
import type { Env } from "../../src/types";
import { baseTestEnv } from "../test-helpers";

// dispatch helper: 1 MCP request を WorkerTransport 経由で Server に流して
// response を取り出す。本番 http-handler が行う bridge と同じ手順。
async function rpc(
  env: Env,
  request: {
    id?: number | string;
    method: string;
    params?: Record<string, unknown>;
  },
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const server = createMcpServer(env);
  const transport = new WorkerTransport();
  await server.connect(transport);
  try {
    const message = {
      jsonrpc: "2.0" as const,
      id: request.id ?? 1,
      method: request.method,
      params: request.params ?? {},
    };
    const msg = await transport.dispatch(message);
    if (msg === null) {
      throw new Error("expected response, got null (notification)");
    }
    return msg as { result?: unknown; error?: { code: number; message: string } };
  } finally {
    await transport.close();
    await server.close();
  }
}

function emptyKv(): KVNamespace {
  return { get: async () => null } as unknown as KVNamespace;
}

function env(overrides: Partial<Env> = {}): Env {
  return baseTestEnv({ SNAPSHOT_KV: emptyKv(), ...overrides }) as Env;
}

describe("MCP server (read MCP)", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        // すべての provider fetch を空の成功 response にする (= row 0 件)。
        // Refs #45 で 3 provider すべて GCP proxy 経由 path-routing になった。
        if (url.includes("/list-secrets")) {
          return Response.json({ secrets: [] });
        }
        if (url.includes("/gh/secrets")) {
          return Response.json({ secrets: [] });
        }
        if (url.includes("/cf/secrets")) {
          return Response.json({ secrets: [] });
        }
        throw new Error(`unexpected fetch in mcp server test: ${url}`);
      },
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initialize returns serverInfo + protocolVersion", async () => {
    const res = await rpc(env(), { method: "initialize", params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    } });
    expect(res.error).toBeUndefined();
    const result = res.result as {
      serverInfo: { name: string; version: string };
      protocolVersion: string;
      capabilities: { tools?: unknown };
    };
    expect(result.serverInfo.name).toBe("secrets-inventory-mcp");
    expect(result.serverInfo.version).toBe("0.0.2");
    expect(result.protocolVersion).toBe("2025-03-26");
    expect(result.capabilities.tools).toBeDefined();
  });

  it("tools/list returns all 12 tools (MUST_READ_FIRST + 4 read + 7 write) with JSON schemas", async () => {
    const res = await rpc(env(), { method: "tools/list" });
    const result = res.result as {
      tools: Array<{ name: string; description: string; inputSchema: unknown }>;
    };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "MUST_READ_FIRST_or_other_tools_will_fail",
      "convert_secret_pkcs8",
      "create_secret",
      "delete_service_token",
      "dry_run_rotate",
      "get_drift",
      "get_snapshot",
      "list_inventory",
      "list_service_accounts",
      "rotate_secret",
      "rotate_service_token",
      "sync_from_gcp",
    ]);
    for (const t of result.tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toMatchObject({ type: "object" });
    }
    // MUST_READ_FIRST tool は agent navigation hint として **先頭** に出す。
    expect(result.tools[0]!.name).toBe("MUST_READ_FIRST_or_other_tools_will_fail");
  });

  it("tools/call unknown tool returns isError result", async () => {
    const res = await rpc(env(), {
      method: "tools/call",
      params: { name: "definitely_not_a_tool", arguments: {} },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("unknown tool");
  });

  it("tools/call rejects invalid arguments (extra field) with isError result", async () => {
    const res = await rpc(env(), {
      method: "tools/call",
      params: { name: "list_inventory", arguments: { bogus_field: 1 } },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("invalid arguments");
  });

  it("tools/call list_inventory returns gathered InventoryResult as JSON", async () => {
    const res = await rpc(env(), {
      method: "tools/call",
      params: { name: "list_inventory", arguments: {} },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.gcp_project_id).toBe("cloudsql-sv");
    expect(Array.isArray(payload.rows)).toBe(true);
  });

  it("tools/call get_snapshot returns null when KV is empty", async () => {
    const kv: KVNamespace = {
      async get() {
        return null;
      },
    } as unknown as KVNamespace;
    const res = await rpc(env({ SNAPSHOT_KV: kv }), {
      method: "tools/call",
      params: { name: "get_snapshot", arguments: {} },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toBeNull();
  });

  it("tools/call propagates GCP unavailable as isError content", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("gcp-stub.run.app")) {
        throw new Error("proxy 502");
      }
      return Response.json({ secrets: [] });
    });
    const res = await rpc(env(), {
      method: "tools/call",
      params: { name: "list_inventory", arguments: {} },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("GCP unavailable");
    expect(result.content[0]!.text).toContain("proxy 502");
  });

  it("list_service_accounts propagates GCP IAM proxy unavailable as isError", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("IAM proxy down");
    });
    const res = await rpc(env(), {
      method: "tools/call",
      params: { name: "list_service_accounts", arguments: {} },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("GCP IAM proxy unavailable");
  });

  it("get_drift filters rows where in_github=false or in_cloudflare=false", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/list-secrets")) {
        return Response.json({
          secrets: [{ name: "ONLY_GCP" }, { name: "EVERYWHERE" }],
        });
      }
      if (url.includes("/gh/secrets")) {
        return Response.json({ secrets: [{ name: "EVERYWHERE" }] });
      }
      if (url.includes("/cf/secrets")) {
        return Response.json({
          secrets: [{ id: "x", name: "EVERYWHERE" }],
        });
      }
      throw new Error(`unexpected: ${url}`);
    });
    const res = await rpc(env(), {
      method: "tools/call",
      params: { name: "get_drift", arguments: {} },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]!.text);
    const names = payload.rows.map((r: { name: string }) => r.name);
    expect(names).toEqual(["ONLY_GCP"]);
  });
});
