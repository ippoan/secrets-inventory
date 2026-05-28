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

export type SyncFromGcpTarget = "gh" | "cf";

export interface SyncFromGcpArgs {
  /** GCP source secret short name */
  srcName: string;
  /** どの provider に伝播させるか */
  targets: SyncFromGcpTarget[];
  /** GitHub Actions secret 名 (省略時は srcName) */
  ghName?: string;
  /** CF Secrets Store 名 (省略時は srcName) */
  cfName?: string;
  /** GitHub visibility — proxy 側 default "all" */
  visibility?: "all" | "private" | "selected";
  /** CF scopes — proxy 側 default "workers" */
  scopes?: string[];
  /** 既存衝突時の振る舞い — proxy 側 default true */
  failIfExists?: boolean;
}

export interface SyncFromGcpProviderResult {
  status: "ok" | "fail";
  error?: string;
  secret_name?: string;
  secret_id?: string;
  created?: boolean;
}

export interface SyncFromGcpResult {
  status: "ok" | "fail";
  source?: string;
  results?: Record<string, SyncFromGcpProviderResult>;
  error?: string;
}

/**
 * Refs ippoan/auth-worker#209 / ippoan/secrets-inventory-gcp#34:
 * proxy `POST /sync-from-gcp/{src_name}?targets=...` を呼ぶ。
 *
 * GCP Secret Manager にある secret 値を、CF Secrets Store / GitHub Actions
 * org secret に伝播する。値は proxy memory のみで取り回し、worker / response
 * body / log に echo されない。
 */
export async function syncFromGcp(
  args: SyncFromGcpArgs,
  ctx: GcpProxyContext,
): Promise<SyncFromGcpResult> {
  const u = new URL(`${ctx.proxyUrl}/sync-from-gcp/${encodeURIComponent(args.srcName)}`);
  u.searchParams.set("targets", args.targets.join(","));
  if (args.ghName) u.searchParams.set("gh_name", args.ghName);
  if (args.cfName) u.searchParams.set("cf_name", args.cfName);
  if (args.visibility) u.searchParams.set("visibility", args.visibility);
  if (args.scopes && args.scopes.length > 0) {
    u.searchParams.set("scopes", args.scopes.join(","));
  }
  if (args.failIfExists !== undefined) {
    u.searchParams.set("fail_if_exists", args.failIfExists ? "true" : "false");
  }

  let res: Response;
  try {
    res = await fetch(u.toString(), { method: "POST", headers: proxyHeaders(ctx) });
  } catch (err) {
    return {
      status: "fail",
      error: `gcp proxy network: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // proxy は 全 target ok なら 200、1 つでも fail なら 502 を返すが body
  // は両方とも詳細な per-target metadata を含む envelope。両方 parse する。
  let parsed: {
    ok?: boolean;
    source?: string;
    results?: Record<string, SyncFromGcpProviderResult>;
  };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch (err) {
    return {
      status: "fail",
      error: `gcp proxy bad json (${res.status}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    status: parsed.ok ? "ok" : "fail",
    source: parsed.source,
    results: parsed.results,
  };
}

// --- convert-pkcs8 (Refs ippoan/secrets-inventory#59) -----------------------

export type ConvertPkcs8Target = "gcp" | "gh";

export interface ConvertPkcs8Args {
  /** GCP source secret short name (PKCS#1 RSA 秘密鍵) */
  srcName: string;
  /** 変換後 (PKCS#8) を保存する別名。既存なら version-up。 */
  dstName: string;
  /** 伝播先。`gcp` 必須 (省略時 ["gcp"])、`gh` 任意。 */
  targets?: ConvertPkcs8Target[];
  /** GitHub Actions secret 名 (省略時は dstName) */
  ghName?: string;
}

export interface ConvertPkcs8Result {
  status: "ok" | "fail";
  source?: string;
  dst_name?: string;
  /** false = source は既に PKCS#8 だった (passthrough) */
  converted?: boolean;
  results?: Record<string, SyncFromGcpProviderResult>;
  error?: string;
}

/**
 * proxy `POST /convert-pkcs8/{src}?dst_name=...&targets=...&gh_name=...` を呼ぶ。
 *
 * GCP の RSA 秘密鍵 (PKCS#1) を PKCS#8 に変換し、別名 dst_name で GCP に作成
 * (既存なら version-up)、任意で GitHub にも propagate する。値は proxy memory
 * のみで取り回し、worker / 応答 body / log に echo されない。
 *
 * 動機: `actions/create-github-app-token@v2` (WebCrypto) は PKCS#8 のみ受理し、
 * GitHub App が download させる PKCS#1 鍵だと "Invalid keyData" で落ちる。
 */
export async function convertPkcs8(
  args: ConvertPkcs8Args,
  ctx: GcpProxyContext,
): Promise<ConvertPkcs8Result> {
  const u = new URL(`${ctx.proxyUrl}/convert-pkcs8/${encodeURIComponent(args.srcName)}`);
  u.searchParams.set("dst_name", args.dstName);
  if (args.targets && args.targets.length > 0) {
    u.searchParams.set("targets", args.targets.join(","));
  }
  if (args.ghName) u.searchParams.set("gh_name", args.ghName);

  let res: Response;
  try {
    res = await fetch(u.toString(), { method: "POST", headers: proxyHeaders(ctx) });
  } catch (err) {
    return {
      status: "fail",
      error: `gcp proxy network: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let parsed: {
    ok?: boolean;
    source?: string;
    dst_name?: string;
    converted?: boolean;
    results?: Record<string, SyncFromGcpProviderResult>;
  };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch (err) {
    return {
      status: "fail",
      error: `gcp proxy bad json (${res.status}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    status: parsed.ok ? "ok" : "fail",
    source: parsed.source,
    dst_name: parsed.dst_name,
    converted: parsed.converted,
    results: parsed.results,
  };
}
