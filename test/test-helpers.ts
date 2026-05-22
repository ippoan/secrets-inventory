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
 * 各 test で個別 field を override しやすいよう、KV と Bearer を除いた共通
 * `Env` 部分だけを返す。SNAPSHOT_KV は test ごとに独自 mock を入れたいため
 * 含めない。MCP_* と INVENTORY_MCP_BEARER は MCP route が増えてから全 test の
 * Env literal に手書きするのを避けるため共通化している。
 */
export function baseTestEnv(
  overrides: Partial<Env> = {},
): Omit<Env, "SNAPSHOT_KV"> & Partial<Pick<Env, "SNAPSHOT_KV">> {
  return {
    CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CF_ACCESS_AUD: "aud",
    CF_ACCOUNT_ID: "acc",
    CF_STORE_ID: "store",
    CF_API_TOKEN: mockSecret("cf-tok"),
    GITHUB_ORG: "ippoan",
    GITHUB_PAT: mockSecret("gh-tok"),
    GCP_PROJECT_ID: "cloudsql-sv",
    GCP_PROXY_URL: "https://gcp-stub.run.app",
    GCP_PROXY_API_KEY: mockSecret("shared-secret"),
    MCP_SERVER_NAME: "secrets-inventory-read-mcp",
    MCP_SERVER_VERSION: "0.0.1",
    MCP_PROTOCOL_VERSION: "2025-03-26",
    INVENTORY_MCP_BEARER: mockSecret("test-bearer"),
    ...overrides,
  };
}
