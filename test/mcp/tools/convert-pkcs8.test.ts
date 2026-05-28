import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createMcpServer } from "../../../src/mcp/server";
import { WorkerTransport } from "../../../src/mcp/transport";
import type { Env } from "../../../src/types";
import type { BindingJwtClaims } from "../../../src/middleware/binding-jwt";
import { baseTestEnv } from "../../test-helpers";

// Refs ippoan/secrets-inventory#58
// `convert_secret_pkcs8` MCP tool: GCP の PKCS#1 鍵を PKCS#8 に変換し別名保存。
// value parameter を持たない設計なので、test の主眼は sync_from_gcp と同様:
//   (a) write tool 扱い (mcp.write scope check)
//   (b) schema 検証 (name / dst_name)
//   (c) proxy 呼び出しの URL / 引数組み立て
//   (d) tools/list に出ること

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

describe("convert_secret_pkcs8 tool", () => {
  it("is listed in tools/list (= discoverable)", async () => {
    const res = await rpc(env(), writeClaims, { method: "tools/list" });
    const result = res.result as { tools: Array<{ name: string; description: string }> };
    const tool = result.tools.find((t) => t.name === "convert_secret_pkcs8");
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/PKCS#8|Invalid keyData/);
  });

  it("requires mcp.write scope (rejected with read-only claims)", async () => {
    const res = await rpc(env(), readOnlyClaims, {
      method: "tools/call",
      params: {
        name: "convert_secret_pkcs8",
        arguments: { name: "CI_APP_PRIVATE_KEY", dst_name: "CI_APP_PRIVATE_KEY_PKCS8" },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/forbidden/i);
    expect(result.content[0]!.text).toMatch(/mcp\.write/);
  });

  it("rejects missing dst_name", async () => {
    const res = await rpc(env(), writeClaims, {
      method: "tools/call",
      params: {
        name: "convert_secret_pkcs8",
        arguments: { name: "CI_APP_PRIVATE_KEY" },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/invalid arguments/i);
  });

  it("rejects invalid name pattern", async () => {
    const res = await rpc(env(), writeClaims, {
      method: "tools/call",
      params: {
        name: "convert_secret_pkcs8",
        arguments: { name: "1invalid", dst_name: "OK_NAME" },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/invalid arguments/i);
  });

  it("calls proxy /convert-pkcs8/:name with dst_name + targets + gh_name", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.startsWith("https://gcp-stub.run.app/convert-pkcs8/CI_APP_PRIVATE_KEY")) {
        return Response.json({
          ok: true,
          source: "CI_APP_PRIVATE_KEY",
          dst_name: "CI_APP_PRIVATE_KEY_PKCS8",
          converted: true,
          results: { gcp: { status: "ok", secret_name: "CI_APP_PRIVATE_KEY_PKCS8", created: true } },
        });
      }
      return new Response("?", { status: 500 });
    });

    const res = await rpc(env(), writeClaims, {
      method: "tools/call",
      params: {
        name: "convert_secret_pkcs8",
        arguments: {
          name: "CI_APP_PRIVATE_KEY",
          dst_name: "CI_APP_PRIVATE_KEY_PKCS8",
          targets: ["gcp", "gh"],
          gh_name: "CI_APP_PRIVATE_KEY",
        },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.status).toBe("ok");
    expect(payload.converted).toBe(true);
    expect(payload.results.gcp.status).toBe("ok");

    const callUrl = fetchSpy.mock.calls[0]![0] as string;
    expect(callUrl).toContain("/convert-pkcs8/CI_APP_PRIVATE_KEY");
    expect(callUrl).toContain("dst_name=CI_APP_PRIVATE_KEY_PKCS8");
    expect(callUrl).toContain("targets=gcp%2Cgh");
    expect(callUrl).toContain("gh_name=CI_APP_PRIVATE_KEY");
  });
});
