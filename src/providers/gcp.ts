import type { Env, SecretMetadata } from "../types";

export class GcpProxyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GcpProxyError";
  }
}

export interface GcpProxyContext {
  proxyUrl: string;
  apiKey: string;
  /** 操作者 email (actor audit log 用)。read 経路では未使用。 */
  actorEmail?: string;
}

/**
 * Cloud Run proxy (ippoan/secrets-inventory-gcp) `main.go` の `secretItem`
 * と 1:1 対応。`name` は proxy 側で `projects/.../secrets/` prefix を剥がした
 * 短縮名で来るが、Worker 側でも shortName() を idempotent にかけて防御する。
 *
 * `updated_at` は proxy で「親 secret の latest version の create_time」を
 * expose したもの (= 最後の rotation 時刻)。proxy 旧 version は未対応で
 * undefined になり得るので optional + 受け側は null fallback。
 */
interface ProxyRawSecret {
  name: string;
  created_at?: string;
  updated_at?: string;
  labels?: Record<string, string>;
}

/** proxy `main.go` の `listResponse` envelope。将来 pagination 拡張余地。 */
interface ProxyListResponse {
  secrets?: ProxyRawSecret[];
}

/**
 * GCP Secret Manager のメタデータ list を Cloud Run proxy 経由で取得する。
 *
 * Worker は GCP credentials を一切持たず、proxy への shared secret header
 * 認証のみで叩く。proxy 側で ADC (Cloud Run attached SA) に変換され、
 * Secret Manager へ。
 */
export async function listGcpSecrets(
  ctx: GcpProxyContext,
): Promise<SecretMetadata[]> {
  const res = await fetch(`${ctx.proxyUrl}/list-secrets`, {
    method: "GET",
    headers: {
      "X-Inventory-API-Key": ctx.apiKey,
      Accept: "application/json",
      "User-Agent": "secrets-inventory",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new GcpProxyError(
      res.status,
      `GCP proxy ${res.status}: ${body}`,
    );
  }

  const raw = (await res.json()) as ProxyListResponse;
  return (raw.secrets ?? []).map((s) => ({
    name: shortName(s.name),
    created_at: s.created_at ?? null,
    updated_at: s.updated_at ?? null,
    extra: {
      labels: s.labels ?? {},
    },
  }));
}

/** `projects/p/secrets/foo` → `foo`。proxy 側でも short 化済みだが防御的に再適用。 */
export function shortName(fullName: string): string {
  const idx = fullName.lastIndexOf("/");
  return idx >= 0 ? fullName.slice(idx + 1) : fullName;
}

// ===========================================================================
// write 系 (= 旧 packages/rotate-mcp の rotateGcp / createGcp を移植)
// ===========================================================================

export interface GcpRotateArgs {
  name: string;
  newValue: string;
  /** TOCTOU 検証用の現 latest version id (= shortName)。省略可。 */
  expectedVersionId?: string;
}

export interface GcpRotateResult {
  status: "ok" | "fail";
  new_version?: string;
  error?: string;
}

/**
 * proxy `POST /add-version` を呼んで既存 secret に新 version を投入する。
 *
 * `expectedVersionId` 指定時は proxy が TOCTOU check (latest version id 一致
 * 確認) を実施し、不一致なら 409 を返す。
 *
 * 失敗は status="fail" で返し throw しない (= 並列実行で他 provider を巻き込まない)。
 */
export async function rotateGcp(
  args: GcpRotateArgs,
  ctx: GcpProxyContext,
): Promise<GcpRotateResult> {
  const url = `${ctx.proxyUrl}/add-version?name=${encodeURIComponent(args.name)}`;
  const headers = proxyHeaders(ctx);
  if (args.expectedVersionId) headers["X-Expected-Version-Id"] = args.expectedVersionId;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ value: args.newValue }),
    });
  } catch (err) {
    return {
      status: "fail",
      error: `gcp proxy network: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    return { status: "fail", error: `gcp proxy ${res.status}: ${body}` };
  }
  let parsed: { ok?: boolean; new_version?: string };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch (err) {
    return {
      status: "fail",
      error: `gcp proxy bad json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!parsed.ok || typeof parsed.new_version !== "string") {
    return { status: "fail", error: "gcp proxy returned ok=false or missing new_version" };
  }
  return { status: "ok", new_version: parsed.new_version };
}

export interface GcpCreateArgs {
  name: string;
  initialValue: string;
  /** true (default) で既存 name 衝突は 409 → fail。false で既存再利用 (= 新 version 投入)。 */
  failIfExists?: boolean;
}

export interface GcpCreateResult extends GcpRotateResult {
  /** 新規作成 = true、既存再利用 = false。 */
  created?: boolean;
}

/**
 * proxy `POST /create-secret` を呼んで新 secret + 初版を投入する。
 */
export async function createGcp(
  args: GcpCreateArgs,
  ctx: GcpProxyContext,
): Promise<GcpCreateResult> {
  const url = `${ctx.proxyUrl}/create-secret?name=${encodeURIComponent(args.name)}`;
  const failIfExists = args.failIfExists ?? true;
  const headers = proxyHeaders(ctx);
  headers["X-Fail-If-Exists"] = failIfExists ? "true" : "false";

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ value: args.initialValue }),
    });
  } catch (err) {
    return {
      status: "fail",
      error: `gcp proxy network: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (res.status === 409) {
    return { status: "fail", error: "gcp secret already exists" };
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    return { status: "fail", error: `gcp proxy ${res.status}: ${body}` };
  }
  let parsed: { ok?: boolean; new_version?: string; created?: boolean };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch (err) {
    return {
      status: "fail",
      error: `gcp proxy bad json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!parsed.ok || typeof parsed.new_version !== "string") {
    return { status: "fail", error: "gcp proxy returned ok=false or missing new_version" };
  }
  return {
    status: "ok",
    new_version: parsed.new_version,
    created: parsed.created === true,
  };
}

function proxyHeaders(ctx: GcpProxyContext): Record<string, string> {
  const h: Record<string, string> = {
    "X-Inventory-API-Key": ctx.apiKey,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "secrets-inventory",
  };
  if (ctx.actorEmail) h["X-Actor-Email"] = ctx.actorEmail;
  return h;
}

/** Env から proxy ctx を組み立てる helper。 */
export async function gcpProxyCtxFromEnv(
  env: Env,
  actorEmail?: string,
): Promise<GcpProxyContext> {
  const apiKey = await env.GCP_PROXY_API_KEY.get();
  return { proxyUrl: env.GCP_PROXY_URL, apiKey, actorEmail };
}

export interface GcpMintHealthOAuthJwtResult {
  status: "ok" | "fail";
  /** mint 先 secret 名 (proxy 側 hardcode = "HEALTH_OAUTH_JWT") */
  secret_name?: string;
  /** 投入された新 version の full name */
  new_version?: string;
  /** 初回 mint = true、既存 secret に追加 version = false */
  created?: boolean;
  /** 投入した JWT の exp (RFC3339)。値そのものは含まない。 */
  expires_at?: string;
  error?: string;
}

/**
 * Refs ippoan/auth-worker#209: proxy `POST /mint-health-oauth-jwt` を呼ぶ。
 *
 * proxy 側で JWT_SECRET の値を AccessSecretVersion で読み出し、HS256 で署名し
 * `HEALTH_OAUTH_JWT` secret を GCP Secret Manager に書き込む。Worker は値を
 * 一切扱わず metadata だけを受け取る。
 *
 * 入力 (`JWT_SECRET`) / 出力 (`HEALTH_OAUTH_JWT`) / payload claims すべて
 * proxy 側に hardcode されているため、リクエスト body は不要。
 */
export async function mintHealthOAuthJwt(
  ctx: GcpProxyContext,
): Promise<GcpMintHealthOAuthJwtResult> {
  const url = `${ctx.proxyUrl}/mint-health-oauth-jwt`;
  const headers = proxyHeaders(ctx);

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers });
  } catch (err) {
    return {
      status: "fail",
      error: `gcp proxy network: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    return { status: "fail", error: `gcp proxy ${res.status}: ${body}` };
  }
  let parsed: {
    ok?: boolean;
    secret_name?: string;
    new_version?: string;
    created?: boolean;
    expires_at?: string;
  };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch (err) {
    return {
      status: "fail",
      error: `gcp proxy bad json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!parsed.ok || typeof parsed.new_version !== "string") {
    return { status: "fail", error: "gcp proxy returned ok=false or missing new_version" };
  }
  return {
    status: "ok",
    secret_name: parsed.secret_name,
    new_version: parsed.new_version,
    created: parsed.created === true,
    expires_at: parsed.expires_at,
  };
}
