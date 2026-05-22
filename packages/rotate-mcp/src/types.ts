import type { CfAccessClaims } from "./middleware/cf-access";

/**
 * `wrangler.jsonc` の vars / secrets_store_secrets と一致させる。
 * Phase A 時点では実書き込み先 (GCP / CF API / GitHub) との binding は持たない。
 */
export interface Env {
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  MCP_SERVER_NAME: string;
  MCP_SERVER_VERSION: string;
  MCP_PROTOCOL_VERSION: string;
  ROTATE_MCP_BEARER: SecretsStoreSecret;
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
