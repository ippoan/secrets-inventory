import type { CfAccessClaims } from "./middleware/cf-access";

/**
 * `wrangler.jsonc` の vars / secrets_store_secrets と一致させる。
 *
 * Phase B から 3 provider の write binding を持つ:
 *   - GCP: Cloud Run proxy (`secrets-inventory-gcp`) 経由で `POST /add-version`
 *   - CF:  CF API 直接 `PATCH /secrets_store/stores/{id}/secrets/{secret_id}`
 *   - GH:  GitHub REST 直接 (libsodium sealed box + PUT org secret)
 *
 * 親 repo (`ippoan/secrets-inventory`) の CLAUDE.md と一致: 値の access が
 * 必要な MCP write 系は **専用 worker (= 本 rotate-mcp) に閉じ込め**、read
 * 専用の inventory worker からは独立。
 */
export interface Env {
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  MCP_SERVER_NAME: string;
  MCP_SERVER_VERSION: string;
  MCP_PROTOCOL_VERSION: string;
  ROTATE_MCP_BEARER: SecretsStoreSecret;

  // GCP provider (= secrets-inventory-gcp Cloud Run proxy 経由)
  GCP_PROJECT_ID: string;
  GCP_PROXY_URL: string;
  GCP_PROXY_API_KEY: SecretsStoreSecret;

  // CF Secrets Store provider (= CF API 直接)
  CF_ACCOUNT_ID: string;
  CF_STORE_ID: string;
  CF_API_TOKEN: SecretsStoreSecret;

  // GitHub Actions org secrets provider (= GitHub REST 直接 + libsodium)
  GITHUB_ORG: string;
  GITHUB_PAT: SecretsStoreSecret;
}

export interface AppVariables {
  cfAccess: CfAccessClaims;
  bearerVerified: true;
}

/** Cloudflare Secrets Store binding が提供する `.get()` interface */
export interface SecretsStoreSecret {
  get(): Promise<string>;
}

export type RotationTarget = "gcp" | "cf" | "github";

export interface RotateSecretArgs {
  name: string;
  new_value: string;
  targets?: RotationTarget[];
  confirm_name: string;
  expected_gcp_version_id?: string;
}

export interface RotateSecretProviderResult {
  status: "ok" | "fail" | "skipped";
  new_version?: string;
  secret_id?: string;
  error?: string;
}

export interface RotateSecretResult {
  ok: boolean;
  rotation_id: string;
  dry_run: boolean;
  results: Partial<Record<RotationTarget, RotateSecretProviderResult>>;
}
