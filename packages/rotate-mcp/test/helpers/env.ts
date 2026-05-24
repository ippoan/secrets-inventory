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
 * drift しやすい → ここに集中させる。
 */
export function makeTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    CF_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    CF_ACCESS_AUD: "test-aud",
    MCP_SERVER_NAME: "secrets-rotate-mcp",
    MCP_SERVER_VERSION: "0.0.2",
    MCP_PROTOCOL_VERSION: "2025-03-26",
    ROTATE_MCP_BEARER: makeStubSecret("test-bearer-token"),

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
