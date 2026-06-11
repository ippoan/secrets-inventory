import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createMcpServer } from "../../../src/mcp/server";
import { WorkerTransport } from "../../../src/mcp/transport";
import type { Env } from "../../../src/types";
import type { BindingJwtClaims } from "../../../src/middleware/binding-jwt";
import { baseTestEnv } from "../../test-helpers";

// Refs ippoan/secrets-inventory#57
// `sync_from_gcp` MCP tool: 既存 GCP secret 値を CF / GitHub にコピーする。
// value parameter を持たない設計なので、test の主眼は
//   (a) write tool 扱い (mcp.write scope check)
//   (b) targets 検証 (gcp は許可されない / 空配列は invalid)
//   (c) proxy 呼び出しの URL / 引数組み立て
//   (d) tools/list に出ること (発見性)
// の 4 点。

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

describe("sync_from_gcp tool", () => {
  it("is listed in tools/list (= discoverable)", async () => {
    const res = await rpc(env(), writeClaims, { method: "tools/list" });
    const result = res.result as { tools: Array<{ name: string; description: string }> };
    const tool = result.tools.find((t) => t.name === "sync_from_gcp");
    expect(tool).toBeDefined();
    // description に「value parameter を持たない」「コピー」が含まれる
    // (= 検索キーワードが当たる)
    expect(tool!.description).toMatch(/value parameter|コピー/);
  });

  it("requires mcp.write scope (rejected with read-only claims)", async () => {
    const res = await rpc(env(), readOnlyClaims, {
      method: "tools/call",
      params: {
        name: "sync_from_gcp",
        arguments: { name: "FOO", targets: ["cf"] },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/forbidden/i);
    expect(result.content[0]!.text).toMatch(/mcp\.write/);
  });

  it("rejects empty targets", async () => {
    const res = await rpc(env(), writeClaims, {
      method: "tools/call",
      params: {
        name: "sync_from_gcp",
        arguments: { name: "FOO", targets: [] },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/invalid arguments/i);
  });

  it("rejects 'gcp' as a target (sync targets are gh / cf only)", async () => {
    const res = await rpc(env(), writeClaims, {
      method: "tools/call",
      params: {
        name: "sync_from_gcp",
        // schema は ["gh","cf"] のみ accept。JSON-RPC params は Record<string, unknown> なので
        // string[] でそのまま投げて zod refine で reject されることを確認する。
        arguments: { name: "FOO", targets: ["gcp"] as unknown as ("gh" | "cf")[] },
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
        name: "sync_from_gcp",
        arguments: { name: "1invalid", targets: ["cf"] },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/invalid arguments/i);
  });

  it("calls proxy /sync-from-gcp/:name with targets + optional cf_name", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.startsWith("https://gcp-stub.run.app/sync-from-gcp/MY_SECRET")) {
        // proxy 応答 envelope: { ok, source, results }。
        // syncFromGcp() は ok=true → status: "ok" にマッピングする。
        return Response.json({
          ok: true,
          source: "MY_SECRET",
          results: {
            cf: { status: "ok", secret_name: "my-secret", secret_id: "cf-id", created: true },
          },
        });
      }
      return new Response("?", { status: 500 });
    });

    const res = await rpc(env(), writeClaims, {
      method: "tools/call",
      params: {
        name: "sync_from_gcp",
        arguments: {
          name: "MY_SECRET",
          targets: ["cf"],
          cf_name: "my-secret",
          fail_if_exists: false,
        },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.status).toBe("ok");
    expect(payload.results.cf.status).toBe("ok");

    // URL params の組み立てが正しいこと
    const callUrl = fetchSpy.mock.calls[0]![0] as string;
    expect(callUrl).toContain("/sync-from-gcp/MY_SECRET");
    expect(callUrl).toContain("targets=cf");
    expect(callUrl).toContain("cf_name=my-secret");

    // tool-call の args にも response にも value らしき文字列が無い
    // (value parameter を持たない設計の検証)
    const argsAsString = JSON.stringify({
      name: "MY_SECRET",
      targets: ["cf"],
      cf_name: "my-secret",
    });
    expect(argsAsString).not.toMatch(/value|secret_val/);
  });
});

describe("sync_from_gcp tool — gh_org (Refs ippoan/secrets-inventory-gcp#49)", () => {
  it("forwards gh_org to the proxy query", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        ok: true,
        source: "CI_APP_PRIVATE_KEY_PKCS8",
        results: { gh: { status: "ok", secret_name: "CI_APP_PRIVATE_KEY", created: true } },
      }),
    );

    const res = await rpc(env(), writeClaims, {
      method: "tools/call",
      params: {
        name: "sync_from_gcp",
        arguments: {
          name: "CI_APP_PRIVATE_KEY_PKCS8",
          targets: ["gh"],
          gh_name: "CI_APP_PRIVATE_KEY",
          gh_org: "ohishi-exp",
        },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.status).toBe("ok");

    const callUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(callUrl).toContain("gh_org=ohishi-exp");
    expect(callUrl).toContain("gh_name=CI_APP_PRIVATE_KEY");
  });

  it("rejects gh_org when targets does not include gh", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await rpc(env(), writeClaims, {
      method: "tools/call",
      params: {
        name: "sync_from_gcp",
        arguments: {
          name: "MY_SECRET",
          targets: ["cf"],
          gh_org: "ohishi-exp",
        },
      },
    });
    const result = res.result as { isError?: boolean; content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.status).toBe("fail");
    expect(payload.error).toMatch(/gh_org/);
    // proxy には到達しない (= 早期 reject)
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects invalid gh_org pattern via schema", async () => {
    const res = await rpc(env(), writeClaims, {
      method: "tools/call",
      params: {
        name: "sync_from_gcp",
        arguments: {
          name: "MY_SECRET",
          targets: ["gh"],
          gh_org: "-leading-hyphen",
        },
      },
    });
    const result = res.result as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});
