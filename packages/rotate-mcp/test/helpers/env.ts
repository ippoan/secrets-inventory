import type { Env, SecretsStoreSecret } from "../../src/types";

/** test 用 SecretsStoreSecret stub。`.get()` で固定文字列を返す。 */
export function makeStubSecret(value: string): SecretsStoreSecret {
  return { get: async () => value };
}

/**
 * test 用の完全 Env を返す factory。fields を override したい場合は
 * `{ ...makeTestEnv(), FIELD: "..." }` で spread する。
 *
 * Phase B で binding が増えたため、各 test が個別に Env literal を組むと
 * drift しやすい → ここに集中させる。Refs #43 で `ROTATE_MCP_BEARER` →
 * `AUTH_WORKER_ORIGIN` に切替。実 fetch は走らせず必ず `introspectFetch`
 * stub で差し替える。
 */
export function makeTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    CF_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    CF_ACCESS_AUD: "test-aud",
    MCP_SERVER_NAME: "secrets-rotate-mcp",
    MCP_SERVER_VERSION: "0.0.2",
    MCP_PROTOCOL_VERSION: "2025-03-26",
    AUTH_WORKER_ORIGIN: "https://auth.invalid",

    GCP_PROJECT_ID: "test-project",
    GCP_PROXY_URL: "https://gcp-proxy.example.invalid",
    GCP_PROXY_API_KEY: makeStubSecret("test-gcp-key"),

    CF_ACCOUNT_ID: "test-cf-account",
    CF_STORE_ID: "test-cf-store",
    CF_API_TOKEN: makeStubSecret("test-cf-token"),

    GITHUB_ORG: "test-org",
    GITHUB_PAT: makeStubSecret("test-gh-pat"),

    ...overrides,
  };
}

/**
 * `bindingJwtMiddleware` test 用の `fetch` stub。`expectedToken` と
 * 一致する Bearer JWT に対してのみ `active:true` を返す。auth-worker
 * `/mcp/introspect` 以外を叩いた場合は 500 を返す (= test の URL bug 検出用)。
 */
export function mockIntrospectFetch(opts: {
  expectedToken: string;
  authWorkerOrigin?: string;
  active?: Partial<{ sub: string; github_login: string; scope: string; exp: number; aud: string }>;
  forceStatus?: number;
  forceBody?: unknown;
}): typeof fetch {
  const origin = opts.authWorkerOrigin ?? "https://auth.invalid";
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url !== `${origin}/mcp/introspect`) {
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
        sub: opts.active?.sub ?? "user:rotate",
        github_login: opts.active?.github_login ?? "octocat",
        scope: opts.active?.scope ?? "mcp.read mcp.write",
        exp: opts.active?.exp ?? Math.floor(Date.now() / 1000) + 3600,
        ...(opts.active?.aud ? { aud: opts.active.aud } : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}
