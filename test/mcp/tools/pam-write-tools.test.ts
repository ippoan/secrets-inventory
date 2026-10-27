import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../../../src/mcp/server";
import { WorkerTransport } from "../../../src/mcp/transport";
import type { Env, GcpTokenRpc } from "../../../src/types";
import type { BindingJwtClaims } from "../../../src/middleware/binding-jwt";
import { generate } from "../../../src/mcp/tools/generate-secret";
import { baseTestEnv } from "../../test-helpers";

// Refs #101: claude@ (MCP に Google でログインした人) の GCP 権限で PAM に申請し、
// 承認後に Secret Manager へ書く tool。Google API は fetch を、auth-worker の RPC は
// AUTH_GCP_TOKEN を差し替えて模擬する。

const BINDING_JWT = "binding.jwt.value";
const claims: BindingJwtClaims = {
  sub: "google:1",
  email: "claude@ippoan.org",
  scope: "mcp.read mcp.write",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

function rpcMock(status = 200, body: unknown = { access_token: "ya29.user" }) {
  return {
    accessToken: vi.fn(async () => ({ status, body: JSON.stringify(body), contentType: "application/json" })),
  } satisfies GcpTokenRpc;
}

/** `null` は binding 自体が無い状態 (既定値は undefined で発火するので null で表す)。 */
function env(token: GcpTokenRpc | null = rpcMock()): Env {
  return baseTestEnv({
    SNAPSHOT_KV: { get: async () => null } as unknown as KVNamespace,
    AUTH_GCP_TOKEN: token ?? undefined,
  }) as Env;
}

const PROJECT = env().GCP_PROJECT_ID;

async function call(
  e: Env,
  name: string,
  args: Record<string, unknown>,
  opts: { claims?: BindingJwtClaims; bindingJwt?: string | null } = {},
) {
  const server = createMcpServer(e, opts.claims ?? claims, {
    bindingJwt: opts.bindingJwt === null ? undefined : (opts.bindingJwt ?? BINDING_JWT),
  });
  const transport = new WorkerTransport();
  await server.connect(transport);
  try {
    const msg = (await transport.dispatch({
      jsonrpc: "2.0" as const,
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    })) as unknown as { result: { content: { text: string }[]; isError: boolean } };
    const text = msg.result.content[0]!.text;
    return { isError: msg.result.isError, text, json: msg.result.isError ? undefined : (JSON.parse(text) as any) };
  } finally {
    await transport.close();
    await server.close();
  }
}

type Route = { method: string; match: RegExp; status: number; body?: unknown };

function google(routes: Route[]) {
  const calls: { method: string; url: string; auth: string | null; body: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      auth: new Headers(init?.headers).get("Authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const route = routes.find((r) => r.method === method && r.match.test(url));
    if (!route) return new Response(JSON.stringify({ error: { message: `unexpected ${method} ${url}` } }), { status: 500 });
    return new Response(route.body === undefined ? "" : JSON.stringify(route.body), { status: route.status });
  });
  return calls;
}

const ENT = `projects/${PROJECT}/locations/global/entitlements/secret-write`;

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("tools/list", () => {
  it("3 つの承認フロー tool が出る", async () => {
    const server = createMcpServer(env(), claims);
    const transport = new WorkerTransport();
    await server.connect(transport);
    const msg = (await transport.dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as unknown as {
      result: { tools: { name: string }[] };
    };
    const names = msg.result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["request_write_access", "get_write_access", "generate_secret"]));
  });
});

describe("request_write_access", () => {
  it("ログインした人のトークンで PAM に申請し、承認画面の URL を返す", async () => {
    const token = rpcMock();
    const calls = google([
      { method: "GET", match: /grants:search\?callerRelationship=HAD_CREATED/, status: 200, body: { grants: [] } },
      {
        method: "POST",
        match: /entitlements\/secret-write\/grants$/,
        status: 200,
        body: { name: `${ENT}/grants/g1`, state: "APPROVAL_AWAITED", requestedDuration: "1800s" },
      },
    ]);
    const res = await call(env(token), "request_write_access", { justification: "pam-approver の secret を作る" });

    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({
      created: true,
      grant: `${ENT}/grants/g1`,
      state: "APPROVAL_AWAITED",
      approve_url: `https://approve.ippoan.org/approve?grant=${encodeURIComponent(`${ENT}/grants/g1`)}`,
    });
    expect(token.accessToken).toHaveBeenCalledWith(BINDING_JWT);
    expect(calls.every((c) => c.auth === "Bearer ya29.user")).toBe(true);
    expect(calls[1]!.body).toEqual({
      requestedDuration: "1800s",
      justification: { unstructuredJustification: "pam-approver の secret を作る (via secrets-inventory MCP, claude@ippoan.org)" },
    });
  });

  it("承認待ち・有効な申請が既にあれば作らずに返す", async () => {
    const calls = google([
      {
        method: "GET",
        match: /grants:search/,
        status: 200,
        body: {
          grants: [
            { name: `${ENT}/grants/old`, state: "ENDED", createTime: "2026-10-26T00:00:00Z" },
            { name: `${ENT}/grants/live`, state: "ACTIVE", createTime: "2026-10-27T00:00:00Z" },
          ],
        },
      },
    ]);
    const res = await call(env(), "request_write_access", { justification: "pam-approver の secret を作る" });
    expect(res.json).toMatchObject({ created: false, grant: `${ENT}/grants/live`, state: "ACTIVE" });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("mcp.write が無ければ呼べない", async () => {
    const res = await call(env(), "request_write_access", { justification: "pam-approver の secret を作る" }, {
      claims: { ...claims, scope: "mcp.read" },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('requires scope "mcp.write"');
  });

  it("GCP の権限が使えない (未同意・7 日切れ) ときは繋ぎ直しを案内する", async () => {
    const expired = await call(env(rpcMock(401, { error: "reauthorize_required" })), "request_write_access", {
      justification: "pam-approver の secret を作る",
    });
    expect(expired.isError).toBe(true);
    expect(expired.text).toContain("MCP コネクタを繋ぎ直し");

    const noToken = await call(env(), "request_write_access", { justification: "pam-approver の secret を作る" }, {
      bindingJwt: null,
    });
    expect(noToken.text).toContain("MCP コネクタを繋ぎ直し");

    const unbound = await call(env(null), "request_write_access", { justification: "pam-approver の secret を作る" });
    expect(unbound.text).toContain("AUTH_GCP_TOKEN");
  });
});

describe("get_write_access", () => {
  it("自分の申請を新しい順に返し、ACTIVE があるかを示す", async () => {
    google([
      {
        method: "GET",
        match: /entitlements\/run-admin\/grants:search/,
        status: 200,
        body: {
          grants: [
            { name: "a", state: "ENDED", createTime: "2026-10-25T00:00:00Z" },
            { name: "b", state: "ACTIVE", createTime: "2026-10-27T00:00:00Z" },
          ],
        },
      },
    ]);
    const res = await call(env(), "get_write_access", { entitlement: "run-admin" });
    expect(res.json.active).toBe(true);
    expect(res.json.grants.map((g: { grant: string }) => g.grant)).toEqual(["b", "a"]);
  });
});

describe("generate_secret", () => {
  const SECRET = `projects/${PROJECT}/secrets/JWT_FOR_PAM_APPROVER`;

  it("値をサーバー側で作り、ログインした人の権限で作成する (値は応答にも引数にも載らない)", async () => {
    const calls = google([
      { method: "GET", match: new RegExp(`${SECRET}$`), status: 404, body: { error: { message: "not found" } } },
      { method: "POST", match: /secrets\?secretId=JWT_FOR_PAM_APPROVER$/, status: 200, body: { name: SECRET } },
      { method: "POST", match: /:addVersion$/, status: 200, body: { name: `${SECRET}/versions/1` } },
    ]);
    const res = await call(env(), "generate_secret", {
      name: "JWT_FOR_PAM_APPROVER",
      kind: "random_hex32",
      labels: { "used-by-ippoan-pam-approver": "active" },
    });

    expect(res.json).toEqual({
      name: "JWT_FOR_PAM_APPROVER",
      kind: "random_hex32",
      created: true,
      version: `${SECRET}/versions/1`,
      next: expect.any(String),
    });
    expect(calls[1]!.body).toEqual({
      replication: { automatic: {} },
      labels: { "used-by-ippoan-pam-approver": "active" },
    });
    const stored = atob((calls[2]!.body as { payload: { data: string } }).payload.data);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(res.text).not.toContain(stored);
  });

  it("承認前 (403) は request_write_access を案内する", async () => {
    google([
      { method: "GET", match: new RegExp(`${SECRET}$`), status: 404 },
      { method: "POST", match: /secrets\?secretId=/, status: 403, body: { error: { message: "denied" } } },
    ]);
    const res = await call(env(), "generate_secret", { name: "JWT_FOR_PAM_APPROVER", kind: "random_hex32" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("request_write_access");
  });

  it("同名があれば既定では失敗し、fail_if_exists: false なら version を足す", async () => {
    google([
      { method: "GET", match: new RegExp(`${SECRET}$`), status: 200, body: { name: SECRET } },
      { method: "POST", match: /:addVersion$/, status: 200, body: { name: `${SECRET}/versions/2` } },
    ]);
    const conflict = await call(env(), "generate_secret", { name: "JWT_FOR_PAM_APPROVER", kind: "random_hex32" });
    expect(conflict.isError).toBe(true);
    const added = await call(env(), "generate_secret", {
      name: "JWT_FOR_PAM_APPROVER",
      kind: "random_hex32",
      fail_if_exists: false,
    });
    expect(added.json).toMatchObject({ created: false, version: `${SECRET}/versions/2` });
  });
});

describe("generate (値の作り方)", () => {
  it("ec_p256_pkcs8 は秘密鍵 PEM を値に、公開鍵 PEM を公開側にする", async () => {
    const g = await generate("ec_p256_pkcs8");
    expect(g.value).toMatch(/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\n$/);
    expect(g.public.public_key_pem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    const der = Uint8Array.from(atob(g.value.replace(/-----[^-]+-----|\n/g, "")), (c) => c.charCodeAt(0));
    await expect(
      crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
    ).resolves.toBeDefined();
  });

  it("vapid は d (32 バイト) を値に、65 バイトの非圧縮公開鍵を公開側にする", async () => {
    const g = await generate("vapid");
    expect(g.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(g.public.vapid_public_key).toMatch(/^[A-Za-z0-9_-]{87}$/);
  });
});
