import { describe, it, expect } from "vitest";
import {
  streamableHttpPost,
  legacySseGet,
  legacySsePost,
} from "../../src/mcp/transport";
import type { Context } from "hono";
import type { Env, AppVariables } from "../../src/types";

// transport handlers を Hono の `app.request()` 経由ではなく **stub Context** で
// 直接呼ぶ unit test。`c.req.json()` が non-Error reject する case や、
// legacy SSE GET の `c` パラメータが未使用であることを確認する。

const env: Env = {
  CF_ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
  CF_ACCESS_AUD: "aud",
  MCP_SERVER_NAME: "secrets-rotate-mcp",
  MCP_SERVER_VERSION: "0.0.1",
  MCP_PROTOCOL_VERSION: "2025-03-26",
  ROTATE_MCP_BEARER: { get: async () => "x" },
};

function stubContext(jsonReject: unknown): Context<{
  Bindings: Env;
  Variables: AppVariables;
}> {
  return {
    env,
    req: {
      json: async () => {
        throw jsonReject;
      },
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
  } as unknown as Context<{ Bindings: Env; Variables: AppVariables }>;
}

describe("streamableHttpPost", () => {
  it("returns 400 + -32700 on Error parse failure", async () => {
    const ctx = stubContext(new Error("bad json"));
    const res = await streamableHttpPost(ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32700);
    expect(body.error.message).toBe("bad json");
  });

  it("returns 400 + -32700 on non-Error parse failure (covers String(err) branch)", async () => {
    const ctx = stubContext("bare-string");
    const res = await streamableHttpPost(ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32700);
    expect(body.error.message).toBe("bare-string");
  });
});

describe("legacySsePost", () => {
  it("returns 400 on Error parse failure", async () => {
    const ctx = stubContext(new Error("bad json sse"));
    const res = await legacySsePost(ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("bad json sse");
  });

  it("returns 400 on non-Error parse failure (covers String(err) branch)", async () => {
    const ctx = stubContext("sse-bare-string");
    const res = await legacySsePost(ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("sse-bare-string");
  });
});

describe("legacySseGet", () => {
  it("ignores context arg and emits endpoint event", async () => {
    // `_c` 未使用パラメータの touch。実 context を渡しても直接読まない事を確認。
    const dummy = {} as unknown as Context<{
      Bindings: Env;
      Variables: AppVariables;
    }>;
    const res = legacySseGet(dummy);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toMatch(/event: endpoint/);
  });
});
