import type { Env, SecretMetadata } from "../types";

// Cloudflare Secrets Store provider。
//
// **Refs #45** 以前は worker が CF API token (`env.CF_API_TOKEN`) を Secrets
// Store binding 経由で持ち、`api.cloudflare.com` を直接叩いていた。Stage 2 で
// 「worker は GCP proxy 経由でしか外部に出ない」ポリシーに統一したため、
// 本 module は **`secrets-inventory-gcp` Cloud Run proxy 経由**に書き換わった。
//
// proxy endpoint (= ippoan/secrets-inventory-gcp#25 で追加):
//   - GET  /cf/secrets        → list
//   - POST /cf/secrets        → create
//   - POST /cf/secrets/{id}   → rotate (PATCH を内部委譲)
//
// 認証は `X-Inventory-API-Key` = `GCP_PROXY_API_KEY` で proxy と共有。
// worker は CF API token を持たない (= proxy が GCP Secret Manager から
// runtime 取得する)。

export class CloudflareProxyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "CloudflareProxyError";
  }
}

export interface CfProxyContext {
  proxyUrl: string;
  apiKey: string;
  /** 操作者 email (actor audit log 用)。read 経路では未使用。 */
  actorEmail?: string;
}

interface CfRawSecret {
  id: string;
  name: string;
  comment?: string | null;
  scopes?: string[] | null;
  status?: string | null;
  created?: string | null;
  modified?: string | null;
}

interface CfListResponse {
  secrets?: CfRawSecret[];
}

/**
 * proxy 経由で CF Secrets Store の secret list を取得。
 * 値は API がそもそも返さない (= proxy も pass-through) ので構造的に値漏洩無し。
 */
export async function listCloudflareSecrets(
  ctx: CfProxyContext,
): Promise<SecretMetadata[]> {
  const res = await fetch(`${ctx.proxyUrl}/cf/secrets`, {
    method: "GET",
    headers: {
      "X-Inventory-API-Key": ctx.apiKey,
      Accept: "application/json",
      "User-Agent": "secrets-inventory",
    },
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new CloudflareProxyError(res.status, `CF proxy ${res.status}: ${body}`);
  }
  const raw = (await res.json()) as CfListResponse;
  return (raw.secrets ?? []).map((s) => ({
    name: s.name,
    id: s.id,
    created_at: s.created ?? null,
    updated_at: s.modified ?? null,
    extra: {
      scopes: s.scopes ?? [],
      comment: s.comment ?? null,
      status: s.status ?? null,
    },
  }));
}

// ===========================================================================
// CF Access Service Token list (Refs #62 / ippoan/secrets-inventory-gcp#38)
//
// Service Token は Secrets Store secret (`/cf/secrets`) とは **別 API**
// (`access/service_tokens`)。proxy 側 `GET /cf/service-tokens` を叩く。
// list は `client_secret` を返さない API なので構造的に値漏洩無し。
// ===========================================================================

interface CfRawServiceToken {
  id: string;
  name: string;
  /** client_id は突合キー候補 (= SM ラベル cf_token_id との照合)。 */
  client_id?: string | null;
  /** token の有効期間 (e.g. "8760h")。期限把握用。 */
  duration?: string | null;
  /** proxy 側で CF の created_at / updated_at を created / modified に正規化済。 */
  created?: string | null;
  modified?: string | null;
}

interface CfServiceTokenListResponse {
  service_tokens?: CfRawServiceToken[];
}

/**
 * proxy 経由で CF Access の Service Token list を取得。
 *
 * 既存 secret (`listCloudflareSecrets`) と区別するため `extra.kind` に
 * `"service_token"` を載せる。突合 (`reconcileServiceTokens`) は `id` を
 * GCP SM ラベル `cf_token_id` と照合する。値 (= client_secret) は API が
 * そもそも返さないので構造的に値漏洩無し。
 */
export async function listCloudflareServiceTokens(
  ctx: CfProxyContext,
): Promise<SecretMetadata[]> {
  const res = await fetch(`${ctx.proxyUrl}/cf/service-tokens`, {
    method: "GET",
    headers: {
      "X-Inventory-API-Key": ctx.apiKey,
      Accept: "application/json",
      "User-Agent": "secrets-inventory",
    },
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new CloudflareProxyError(res.status, `CF proxy ${res.status}: ${body}`);
  }
  const raw = (await res.json()) as CfServiceTokenListResponse;
  return (raw.service_tokens ?? []).map((t) => ({
    name: t.name,
    id: t.id,
    created_at: t.created ?? null,
    updated_at: t.modified ?? null,
    extra: {
      kind: "service_token",
      client_id: t.client_id ?? null,
      duration: t.duration ?? null,
    },
  }));
}

// ===========================================================================
// write 系 (= 旧 packages/rotate-mcp の rotateCloudflare / createCloudflare を
// proxy 経由に書き換えたもの)
// ===========================================================================

export interface CfRotateArgs {
  name: string;
  newValue: string;
}

export interface CfRotateResult {
  status: "ok" | "fail";
  secret_id?: string;
  error?: string;
}

/**
 * 既存 secret の値を更新 (= rotation):
 *   1) proxy `GET /cf/secrets` で name → id を解決
 *   2) proxy `POST /cf/secrets/{id}` で値を更新
 *
 * 失敗は status="fail" で返し throw しない (= 並列実行で他 provider を巻き込まない)。
 * 値は body の `value` field のみ、log / response に echo しない。
 */
export async function rotateCloudflare(
  args: CfRotateArgs,
  ctx: CfProxyContext,
): Promise<CfRotateResult> {
  const id = await resolveSecretId(args.name, ctx);
  if (id.kind === "error") return { status: "fail", error: id.error };
  if (id.kind === "not_found") {
    return { status: "fail", error: `cf secret not found: ${args.name}` };
  }

  let res: Response;
  try {
    res = await fetch(`${ctx.proxyUrl}/cf/secrets/${id.id}`, {
      method: "POST",
      headers: proxyHeaders(ctx),
      body: JSON.stringify({ value: args.newValue }),
    });
  } catch (err) {
    return {
      status: "fail",
      error: `cf proxy network: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    return { status: "fail", error: `cf proxy ${res.status}: ${body}` };
  }
  return { status: "ok", secret_id: id.id };
}

export interface CfCreateArgs {
  name: string;
  initialValue: string;
  /** false で既存 secret 再利用 (= rotate 経路に降りる)。default true. */
  failIfExists?: boolean;
  /** CF Secrets Store scopes (e.g. ["workers"])。default = proxy 側 ["workers"]。 */
  scopes?: string[];
}

export interface CfCreateResult extends CfRotateResult {
  /** 新規作成 = true、既存再利用 = false。conflict (= fail) では undefined。 */
  created?: boolean;
}

/**
 * 新規 secret 作成。`fail_if_exists` semantics は **worker (本関数) 側で
 * list-then-create** で実装する:
 *
 *   1) GET /cf/secrets で既存 name 有無を確認
 *   2) 既存 + fail_if_exists=true → fail
 *      既存 + fail_if_exists=false → rotate (POST /cf/secrets/{id}) で値だけ更新
 *      不存在 → POST /cf/secrets で create
 *
 * proxy は単純な POST だけ提供する設計 (= proxy をシンプルに保ち、existence
 * 判定 + 分岐は worker 側に閉じる)。
 */
export async function createCloudflare(
  args: CfCreateArgs,
  ctx: CfProxyContext,
): Promise<CfCreateResult> {
  const failIfExists = args.failIfExists ?? true;

  const existing = await resolveSecretId(args.name, ctx);
  if (existing.kind === "error") return { status: "fail", error: existing.error };

  if (existing.kind === "found") {
    if (failIfExists) {
      return { status: "fail", error: "cf secret already exists" };
    }
    // 既存再利用: rotate 経路で値だけ更新
    const rotated = await rotateCloudflare(
      { name: args.name, newValue: args.initialValue },
      ctx,
    );
    if (rotated.status !== "ok") return rotated;
    return { ...rotated, created: false };
  }

  // 新規 create
  let res: Response;
  try {
    res = await fetch(`${ctx.proxyUrl}/cf/secrets`, {
      method: "POST",
      headers: proxyHeaders(ctx),
      body: JSON.stringify({
        name: args.name,
        value: args.initialValue,
        scopes: args.scopes,
      }),
    });
  } catch (err) {
    return {
      status: "fail",
      error: `cf proxy network: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    return { status: "fail", error: `cf proxy ${res.status}: ${body}` };
  }
  let parsed: { ok?: boolean; secret_id?: string };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch (err) {
    return {
      status: "fail",
      error: `cf proxy bad json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!parsed.ok || typeof parsed.secret_id !== "string") {
    return { status: "fail", error: "cf proxy returned ok=false or missing secret_id" };
  }
  return { status: "ok", secret_id: parsed.secret_id, created: true };
}

type ResolvedId =
  | { kind: "found"; id: string }
  | { kind: "not_found" }
  | { kind: "error"; error: string };

async function resolveSecretId(name: string, ctx: CfProxyContext): Promise<ResolvedId> {
  let secrets: SecretMetadata[];
  try {
    secrets = await listCloudflareSecrets(ctx);
  } catch (err) {
    return {
      kind: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const hit = secrets.find((s) => s.name === name);
  if (!hit || !hit.id) return { kind: "not_found" };
  return { kind: "found", id: hit.id };
}

function proxyHeaders(ctx: CfProxyContext): Record<string, string> {
  const h: Record<string, string> = {
    "X-Inventory-API-Key": ctx.apiKey,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "secrets-inventory",
  };
  if (ctx.actorEmail) h["X-Actor-Email"] = ctx.actorEmail;
  return h;
}

// ===========================================================================
// Phase 2: Service Token rotate / delete (Refs #64 / proxy #40)
//
// proxy 側 `POST /cf/service-tokens/{id}/rotate` と `DELETE
// /cf/service-tokens/{id}` を呼ぶ。rotate の新 client_secret は **proxy →
// GCP Secret Manager 直書き**なので worker は値を一切扱わない (= LLM context
// に載らない)。戻り値は metadata のみ。
// ===========================================================================

export interface CfRotateServiceTokenArgs {
  /** CF service token id (= list の id / 突合キー)。 */
  tokenId: string;
  /** 新 client_secret の着地先 GCP SM short name。 */
  smSecretName: string;
  /** SM 側既存衝突時に 409(true) か 既存再利用=新 version(false)。default false。 */
  failIfExists?: boolean;
}

export interface CfServiceTokenWriteResult {
  status: "ok" | "fail";
  token_id?: string;
  /** create のみ: 発行された token の表示名。 */
  name?: string;
  client_id?: string;
  expires_at?: string;
  client_secret_version?: number;
  sm_secret_name?: string;
  sm_version?: string;
  created?: boolean;
  error?: string;
}

/**
 * service token を rotate (= 新 client_secret 発行 → proxy が SM へ直書き)。
 * 失敗は status="fail" で返し throw しない。値は worker を経由しない。
 */
export async function rotateCloudflareServiceToken(
  args: CfRotateServiceTokenArgs,
  ctx: CfProxyContext,
): Promise<CfServiceTokenWriteResult> {
  let res: Response;
  try {
    res = await fetch(
      `${ctx.proxyUrl}/cf/service-tokens/${encodeURIComponent(args.tokenId)}/rotate`,
      {
        method: "POST",
        headers: proxyHeaders(ctx),
        body: JSON.stringify({
          sm_secret_name: args.smSecretName,
          fail_if_exists: args.failIfExists ?? false,
        }),
      },
    );
  } catch (err) {
    return {
      status: "fail",
      error: `cf proxy network: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    return { status: "fail", error: `cf proxy ${res.status}: ${body}` };
  }
  let parsed: {
    ok?: boolean;
    token_id?: string;
    client_id?: string;
    expires_at?: string;
    client_secret_version?: number;
    sm_secret_name?: string;
    sm_version?: string;
    created?: boolean;
  };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch (err) {
    return {
      status: "fail",
      error: `cf proxy bad json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!parsed.ok || typeof parsed.token_id !== "string") {
    return { status: "fail", error: "cf proxy returned ok=false or missing token_id" };
  }
  return {
    status: "ok",
    token_id: parsed.token_id,
    client_id: parsed.client_id,
    expires_at: parsed.expires_at,
    client_secret_version: parsed.client_secret_version,
    sm_secret_name: parsed.sm_secret_name,
    sm_version: parsed.sm_version,
    created: parsed.created,
  };
}

export interface CfDeleteServiceTokenArgs {
  tokenId: string;
}

/**
 * service token を delete (= 野良 token revoke)。値・SM 連携なし。
 * 失敗は status="fail" で返し throw しない。
 */
export async function deleteCloudflareServiceToken(
  args: CfDeleteServiceTokenArgs,
  ctx: CfProxyContext,
): Promise<CfServiceTokenWriteResult> {
  let res: Response;
  try {
    res = await fetch(
      `${ctx.proxyUrl}/cf/service-tokens/${encodeURIComponent(args.tokenId)}`,
      { method: "DELETE", headers: proxyHeaders(ctx) },
    );
  } catch (err) {
    return {
      status: "fail",
      error: `cf proxy network: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    return { status: "fail", error: `cf proxy ${res.status}: ${body}` };
  }
  let parsed: { ok?: boolean; token_id?: string };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch (err) {
    return {
      status: "fail",
      error: `cf proxy bad json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!parsed.ok || typeof parsed.token_id !== "string") {
    return { status: "fail", error: "cf proxy returned ok=false or missing token_id" };
  }
  return { status: "ok", token_id: parsed.token_id };
}

export interface CfCreateServiceTokenArgs {
  /** 発行する CF service token の表示名。 */
  name: string;
  /** 発行時のみ返る client_secret の着地先 GCP SM short name。 */
  smSecretName: string;
  /** CF token duration (e.g. "8760h")。省略時は CF default。 */
  duration?: string;
  /** SM 側既存衝突時に 409(true) か 既存再利用=新 version(false)。default false。 */
  failIfExists?: boolean;
}

/**
 * service token を新規発行 (= create)。発行時のみ返る client_secret は
 * **proxy → GCP SM 直書き**で worker / LLM context を経由しない。戻り値は
 * metadata のみ。失敗は status="fail" で返し throw しない。
 */
export async function createCloudflareServiceToken(
  args: CfCreateServiceTokenArgs,
  ctx: CfProxyContext,
): Promise<CfServiceTokenWriteResult> {
  let res: Response;
  try {
    res = await fetch(`${ctx.proxyUrl}/cf/service-tokens`, {
      method: "POST",
      headers: proxyHeaders(ctx),
      body: JSON.stringify({
        name: args.name,
        sm_secret_name: args.smSecretName,
        ...(args.duration ? { duration: args.duration } : {}),
        fail_if_exists: args.failIfExists ?? false,
      }),
    });
  } catch (err) {
    return {
      status: "fail",
      error: `cf proxy network: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    return { status: "fail", error: `cf proxy ${res.status}: ${body}` };
  }
  let parsed: {
    ok?: boolean;
    token_id?: string;
    name?: string;
    client_id?: string;
    expires_at?: string;
    sm_secret_name?: string;
    sm_version?: string;
    created?: boolean;
  };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch (err) {
    return {
      status: "fail",
      error: `cf proxy bad json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!parsed.ok || typeof parsed.token_id !== "string") {
    return { status: "fail", error: "cf proxy returned ok=false or missing token_id" };
  }
  return {
    status: "ok",
    token_id: parsed.token_id,
    name: parsed.name,
    client_id: parsed.client_id,
    expires_at: parsed.expires_at,
    sm_secret_name: parsed.sm_secret_name,
    sm_version: parsed.sm_version,
    created: parsed.created,
  };
}

/**
 * Env から proxy ctx を組み立てる helper。inventory.ts / tool 実装から共通利用。
 * API key の取得 (= Secrets Store binding `.get()`) も一緒にやる。
 */
export async function cfProxyCtxFromEnv(
  env: Env,
  actorEmail?: string,
): Promise<CfProxyContext> {
  const apiKey = await env.GCP_PROXY_API_KEY.get();
  return { proxyUrl: env.GCP_PROXY_URL, apiKey, actorEmail };
}
