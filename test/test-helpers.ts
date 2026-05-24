import type { Env } from "../src/types";

/**
 * テストで使う `Secrets Store binding` 互換オブジェクト。実 binding は
 * @cloudflare/workers-types の ambient `SecretsStoreSecret` で declare されて
 * いるが、`.get()` のみ呼ばれるためここでは duck-typing で十分。
 */
export function mockSecret(value: string): SecretsStoreSecret {
  return { get: async () => value } as unknown as SecretsStoreSecret;
}

/**
 * 各 test で個別 field を override しやすいよう、KV を除いた共通
 * `Env` 部分だけを返す。SNAPSHOT_KV は test ごとに独自 mock を入れたいため
 * 含めない。MCP_* は MCP route が増えてから全 test の Env literal に手書き
 * するのを避けるため共通化している。
 *
 * `AUTH_WORKER_ORIGIN` は MCP route 認証 (`binding_jwt`) 用 #43 で導入。
 * test では `https://auth.invalid` を使い、実 fetch が走らないよう
 * `bindingJwtMiddleware({ introspectFetch })` で必ず stub する。
 */
export function baseTestEnv(
  overrides: Partial<Env> = {},
): Omit<Env, "SNAPSHOT_KV"> & Partial<Pick<Env, "SNAPSHOT_KV">> {
  return {
    CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CF_ACCESS_AUD: "aud",
    CF_ACCOUNT_ID: "acc",
    CF_STORE_ID: "store",
    GITHUB_ORG: "ippoan",
    GCP_PROJECT_ID: "cloudsql-sv",
    GCP_PROXY_URL: "https://gcp-stub.run.app",
    GCP_PROXY_API_KEY: mockSecret("shared-secret"),
    MCP_SERVER_NAME: "secrets-inventory-mcp",
    MCP_SERVER_VERSION: "0.0.2",
    MCP_PROTOCOL_VERSION: "2025-03-26",
    AUTH_WORKER_ORIGIN: "https://auth.invalid",
    ...overrides,
  };
}

/**
 * `bindingJwtMiddleware` test 用の `fetch` stub factory。`expectedToken` と
 * 一致する Authorization Bearer JWT が来た時だけ `active:true` を返す。
 * URL 引数の検証もしておく (= auth-worker 以外を叩いてしまわないように)。
 */
export function mockIntrospectFetch(opts: {
  expectedToken: string;
  authWorkerOrigin: string;
  active?: Partial<{ sub: string; github_login: string; scope: string; exp: number; aud: string }>;
  forceStatus?: number;
  forceBody?: unknown;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url !== `${opts.authWorkerOrigin}/mcp/introspect`) {
      return new Response("wrong URL: " + url, { status: 500 });
    }
    if (opts.forceStatus !== undefined) {
      return new Response(JSON.stringify(opts.forceBody ?? {}), {
        status: opts.forceStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    const authz = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "";
    if (authz !== `Bearer ${opts.expectedToken}`) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        active: true,
        sub: opts.active?.sub ?? "user:42",
        github_login: opts.active?.github_login ?? "octocat",
        scope: opts.active?.scope ?? "mcp.read mcp.write",
        exp: opts.active?.exp ?? Math.floor(Date.now() / 1000) + 3600,
        ...(opts.active?.aud ? { aud: opts.active.aud } : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}
