/**
 * 各プロバイダーが返す secret のメタデータ。値フィールドは持たない。
 *
 * 名前 (`name`) は突合のキーとなるため必須。それ以外の項目はプロバイダー側で
 * 取れる場合のみセットする。
 */
export interface SecretMetadata {
  name: string;
  id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  /** GitHub: visibility, Cloudflare: scopes, GCP: labels の人間可読な要約等 */
  extra?: Record<string, unknown> | null;
}

/**
 * 1 プロバイダーの list 結果。エラー時は `secrets` を返さず `error` を返す。
 */
export interface ProviderListResult {
  provider: "gcp" | "github" | "cloudflare";
  secrets: SecretMetadata[];
}

export interface ProviderListError {
  provider: "gcp" | "github" | "cloudflare";
  error: string;
}

export interface Env {
  // Cloudflare Access (Google OAuth)
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;

  // Cloudflare Secrets Store (突合対象)
  CF_ACCOUNT_ID: string;
  CF_STORE_ID: string;
  CF_API_TOKEN: SecretsStoreSecret;

  // GitHub org secrets (突合対象)
  GITHUB_ORG: string;
  GITHUB_PAT: SecretsStoreSecret;

  // GCP Secret Manager (正)
  GCP_PROJECT_ID: string;
  GCP_SA_KEY: SecretsStoreSecret;

  // KV: PR3 で前回の name 一覧スナップショットを格納
  SNAPSHOT_KV: KVNamespace;
}
