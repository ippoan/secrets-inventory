import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createMcpServer } from "../../../src/mcp/server";
import { WorkerTransport } from "../../../src/mcp/transport";
import type { Env } from "../../../src/types";
import type { BindingJwtClaims } from "../../../src/middleware/binding-jwt";
import { baseTestEnv } from "../../test-helpers";

// set_repo_variable / list_repo_variables: GitHub Actions repo variables
// (平文 config、secret ではない) を proxy /gh/variables 経由で操作する。

async function rpc(
  env: Env,
  claims: BindingJwtClaims | undefined,
  request: { id?: number | string; method: string; params?: Record<string, unknown> },
) {
  const server = createMcpServer(env, claims);
  const transport = new WorkerTransport();
  await server.connect(transport);
  try {
    const msg = await transport.dispatch({
      jsonrpc: "2.0" as const,
      id: request.id ?? 1,
      method: request.method,
      params: request.params ?? {},
    });
    if (msg === null) throw new Error("expected response");
    return msg as { result?: unknown; error?: { code: number; message: string } };
  } finally {
    await transport.close();
    await server.close();
  }
}

function env(): Env {
  return baseTestEnv({ SNAPSHOT_KV: { get: async () => null } as unknown as KVNamespace }) as Env;
}

const writeClaims: BindingJwtClaims = {
  sub: "user:42",
  github_login: "octocat",
  scope: "mcp.read mcp.write",
  exp: Math.floor(Date.now() / 1000) + 3600,
};
const readOnlyClaims: BindingJwtClaims = { ...writeClaims, scope: "mcp.read" };

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("set_repo_variable tool", () => {
  it("is listed in tools/list (= discoverable)", async () => {
    const res = await rpc(env(), writeClaims, { method: "tools/list" });
    const result = res.result as { tools: Array<{ name: string }> };
    expect(result.tools.find((t) => t.name === "set_repo_variable")).toBeDefined();
    expect(result.tools.find((t) => t.name === "list_repo_variables")).toBeDefined();
  });

  it("requires mcp.write scope (rejected with read-only claims)", async () => {
    const res = await rpc(env(), readOnlyClaims, {
      method: "tools/call",
      params: {
        name: "set_repo_variable",
        arguments: { repo: "ippoan/rust-flickr", name: "STAGING_DEPLOY_ENABLED", value: "true" },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/forbidden/i);
    expect(result.content[0]!.text).toMatch(/mcp\.write/);
  });

  it("rejects invalid repo (not owner/name)", async () => {
    const res = await rpc(env(), writeClaims, {
      method: "tools/call",
      params: {
        name: "set_repo_variable",
        arguments: { repo: "noslash", name: "FOO", value: "x" },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/invalid arguments/i);
  });

  it("rejects invalid variable name", async () => {
    const res = await rpc(env(), writeClaims, {
      method: "tools/call",
      params: {
        name: "set_repo_variable",
        arguments: { repo: "ippoan/rust-flickr", name: "1bad", value: "x" },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/invalid arguments/i);
  });

  it("calls proxy PUT /gh/variables/{name}?repo=... and maps created", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: true, created: true }),
    );
    const res = await rpc(env(), writeClaims, {
      method: "tools/call",
      params: {
        name: "set_repo_variable",
        arguments: { repo: "ippoan/rust-flickr", name: "STAGING_DEPLOY_ENABLED", value: "true" },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.status).toBe("ok");
    expect(payload.created).toBe(true);

    const callUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(callUrl).toContain("/gh/variables/STAGING_DEPLOY_ENABLED");
    expect(callUrl).toContain("repo=ippoan%2Frust-flickr");
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["X-Inventory-API-Key"]).toBeTruthy();
  });
});

describe("list_repo_variables tool", () => {
  it("returns variables (name + value, 平文 config)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        variables: [
          { name: "STAGING_DEPLOY_ENABLED", value: "true", created_at: "2026-01-01", updated_at: "2026-05-01" },
        ],
      }),
    );
    const res = await rpc(env(), writeClaims, {
      method: "tools/call",
      params: {
        name: "list_repo_variables",
        arguments: { repo: "ippoan/rust-flickr" },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.variables).toHaveLength(1);
    expect(payload.variables[0].name).toBe("STAGING_DEPLOY_ENABLED");
    expect(payload.variables[0].value).toBe("true");
  });
});
