import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createMcpServer } from "../../../src/mcp/server";
import { WorkerTransport } from "../../../src/mcp/transport";
import type { Env } from "../../../src/types";
import type { BindingJwtClaims } from "../../../src/middleware/binding-jwt";
import { baseTestEnv } from "../../test-helpers";

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

describe("rotate_secret tool", () => {
  it("requires mcp.write scope (rejected with read-only claims)", async () => {
    const res = await rpc(env(), readOnlyClaims, {
      method: "tools/call",
      params: {
        name: "rotate_secret",
        arguments: { name: "FOO", new_value: "v", confirm_name: "FOO" },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/forbidden/i);
    expect(result.content[0]!.text).toMatch(/mcp\.write/);
  });

  it("validates confirm_name == name", async () => {
    const res = await rpc(env(), writeClaims, {
      method: "tools/call",
      params: {
        name: "rotate_secret",
        arguments: { name: "FOO", new_value: "v", confirm_name: "WRONG" },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/invalid arguments/);
  });

  it("rejects targets without gcp (= GCP source-of-truth enforcement)", async () => {
    // `targets: ["github"]` のように GCP を含まない指定は schema refine で
    // 弾く。CLAUDE.md「GCP が正 (source of truth)」原則。route 層側でも
    // 同じ check (test/routes/secret-upload.test.ts) を持つ。
    for (const t of [["github"], ["cf"], ["cf", "github"]]) {
      const res = await rpc(env(), writeClaims, {
        method: "tools/call",
        params: {
          name: "rotate_secret",
          arguments: { name: "FOO", new_value: "v", confirm_name: "FOO", targets: t },
        },
      });
      const result = res.result as { isError: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/source of truth|must include 'gcp'/);
    }
  });

  it("invokes 3 provider proxy endpoints with mcp.write scope", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/add-version")) {
        return Response.json({ ok: true, new_version: "projects/p/secrets/FOO/versions/2" });
      }
      if (url.endsWith("/cf/secrets")) {
        return Response.json({ secrets: [{ id: "cf-id", name: "FOO" }] });
      }
      if (url.includes("/cf/secrets/cf-id")) {
        return Response.json({ ok: true, secret_id: "cf-id" });
      }
      if (url.includes("/gh/secrets/FOO")) {
        return Response.json({ ok: true });
      }
      return new Response("?", { status: 500 });
    });

    const res = await rpc(env(), writeClaims, {
      method: "tools/call",
      params: {
        name: "rotate_secret",
        arguments: { name: "FOO", new_value: "new-val", confirm_name: "FOO" },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.ok).toBe(true);
    expect(payload.results.gcp.status).toBe("ok");
    expect(payload.results.cf.status).toBe("ok");
    expect(payload.results.github.status).toBe("ok");

    // new_val が response に echo されていないこと
    expect(result.content[0]!.text).not.toContain("new-val");
    // 各 upstream の PUT/POST body には new_val が乗っていること
    let foundValue = false;
    for (const [, init] of fetchSpy.mock.calls) {
      const body = (init as RequestInit | undefined)?.body;
      if (typeof body === "string" && body.includes("new-val")) foundValue = true;
    }
    expect(foundValue).toBe(true);
  });

  it("partial fail: github 502 → ok=false, others still ok", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/add-version")) {
        return Response.json({ ok: true, new_version: "v/1" });
      }
      if (url.endsWith("/cf/secrets")) {
        return Response.json({ secrets: [{ id: "cf-id", name: "FOO" }] });
      }
      if (url.includes("/cf/secrets/cf-id")) {
        return Response.json({ ok: true, secret_id: "cf-id" });
      }
      if (url.includes("/gh/secrets/FOO")) {
        return new Response("gh upstream error", { status: 502 });
      }
      return new Response("?", { status: 500 });
    });
    const res = await rpc(env(), writeClaims, {
      method: "tools/call",
      params: {
        name: "rotate_secret",
        arguments: { name: "FOO", new_value: "v", confirm_name: "FOO" },
      },
    });
    const payload = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0]!.text);
    expect(payload.ok).toBe(false);
    expect(payload.results.gcp.status).toBe("ok");
    expect(payload.results.cf.status).toBe("ok");
    expect(payload.results.github.status).toBe("fail");
  });
});

describe("dry_run_rotate tool", () => {
  it("works without mcp.write scope (read-only side-effect=0)", async () => {
    const res = await rpc(env(), readOnlyClaims, {
      method: "tools/call",
      params: { name: "dry_run_rotate", arguments: { name: "FOO" } },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.dry_run).toBe(true);
    expect(payload.results.gcp.status).toBe("skipped");
    expect(payload.results.cf.status).toBe("skipped");
    expect(payload.results.github.status).toBe("skipped");
  });
});

describe("create_secret tool", () => {
  it("requires mcp.write scope", async () => {
    const res = await rpc(env(), readOnlyClaims, {
      method: "tools/call",
      params: {
        name: "create_secret",
        arguments: { name: "NEW", initial_value: "v", confirm_name: "NEW" },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/forbidden/i);
  });

  it("creates new secret on all 3 systems", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/create-secret")) {
        return Response.json({ ok: true, new_version: "v/1", created: true });
      }
      if (url.endsWith("/cf/secrets") && init?.method === "GET") {
        return Response.json({ secrets: [] });
      }
      if (url.endsWith("/cf/secrets") && init?.method === "POST") {
        return Response.json({ ok: true, secret_id: "new-id" });
      }
      if (url.includes("/gh/secrets/NEW")) {
        return Response.json({ ok: true, created: true });
      }
      return new Response("?", { status: 500 });
    });
    const res = await rpc(env(), writeClaims, {
      method: "tools/call",
      params: {
        name: "create_secret",
        arguments: { name: "NEW", initial_value: "v", confirm_name: "NEW" },
      },
    });
    const payload = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0]!.text);
    expect(payload.ok).toBe(true);
    expect(payload.results.gcp.created).toBe(true);
    expect(payload.results.cf.created).toBe(true);
    expect(payload.results.github.created).toBe(true);
  });

  it("rejects targets without gcp (= GCP source-of-truth enforcement)", async () => {
    for (const t of [["github"], ["cf"], ["cf", "github"]]) {
      const res = await rpc(env(), writeClaims, {
        method: "tools/call",
        params: {
          name: "create_secret",
          arguments: { name: "NEW", initial_value: "v", confirm_name: "NEW", targets: t },
        },
      });
      const result = res.result as { isError: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/source of truth|must include 'gcp'/);
    }
  });
});
