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

  // CF / GitHub の inventory + write も **Cloud Run proxy 経由**に統一
  // (Refs #45)。worker は CF API token / GitHub PAT を持たず、proxy 側で
  // GCP Secret Manager から runtime 取得する。worker が持つ secret は
  // `GCP_PROXY_API_KEY` 1 個だけ。
  CF_ACCOUNT_ID: string;
  CF_STORE_ID: string;
  GITHUB_ORG: string;

  // Phase 2 (Refs #64): rotate/delete を **拒否**する CF service token id の
  // カンマ区切りリスト (= 管理系 / 現役で消すと困る token の保護 = 自殺トークン
  // 対策)。未設定なら保護なし。
  CF_SERVICE_TOKEN_PROTECTED_IDS?: string;

  // GCP Secret Manager (正) — Cloud Run proxy 経由でアクセス。
  // proxy code は ippoan/secrets-inventory-gcp、SA key は発行しない (ADC)。
  GCP_PROJECT_ID: string;
  GCP_PROXY_URL: string;
  GCP_PROXY_API_KEY: SecretsStoreSecret;

  // KV: PR3 で前回の name 一覧スナップショットを格納
  SNAPSHOT_KV: KVNamespace;

  // MCP server (read MCP route `/mcp`)。CF Access の上に auth-worker
  // (`AUTH_WORKER_ORIGIN`) が mint した `binding_jwt` (Bearer) の二重認証を
  // 載せて AI client / tool call を identify する。binding_jwt は
  // `POST {AUTH_WORKER_ORIGIN}/mcp/introspect` Mode 1 で verify するため、
  // 本 worker は shared secret を持たない (Refs #43)。MCP_* vars は
  // initialize / serverInfo response の出処。
  MCP_SERVER_NAME: string;
  MCP_SERVER_VERSION: string;
  MCP_PROTOCOL_VERSION: string;
  AUTH_WORKER_ORIGIN: string;

  // DO + WebSocket (stateful) MCP transport (Refs #70)。dual-path で `/mcp-do`
  // に追加した DO session の binding。class は `SecretsInventoryMcp`
  // (src/mcp/durable.ts)。wrangler.jsonc の durable_objects + migration で登録。
  MCP_DO: DurableObjectNamespace;
}
