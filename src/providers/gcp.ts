import type { SecretMetadata } from "../types";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SECRET_MANAGER_API = "https://secretmanager.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform.read-only";
/** assertion 有効期限 (秒)。GCP 上限は 3600 だが、time skew を見越して 1 時間で固定。 */
const JWT_LIFETIME_SEC = 3600;

export class GcpApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GcpApiError";
  }
}

export interface GcpServiceAccountKey {
  type: string;
  project_id?: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
  token_uri?: string;
}

export interface GcpContext {
  serviceAccountKey: GcpServiceAccountKey;
  projectId: string;
}

/**
 * SA JSON 文字列を parse して GcpServiceAccountKey にする。
 * 形式不正は GcpApiError で弾く。
 */
export function parseServiceAccountKey(json: string): GcpServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new GcpApiError(500, `GCP SA key JSON parse failed: ${err}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new GcpApiError(500, "GCP SA key is not an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.private_key !== "string" || obj.private_key.length === 0) {
    throw new GcpApiError(500, "GCP SA key missing private_key");
  }
  if (typeof obj.client_email !== "string" || obj.client_email.length === 0) {
    throw new GcpApiError(500, "GCP SA key missing client_email");
  }
  return obj as unknown as GcpServiceAccountKey;
}

function base64UrlEncode(input: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    bytes = input;
  }
  // btoa は ASCII 文字列だけしか受け取れないので、Uint8Array を 1 文字ずつ詰める
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const stripped = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(stripped);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    buf[i] = bin.charCodeAt(i);
  }
  return buf.buffer;
}

/**
 * Workers 標準の Web Crypto で SA 秘密鍵から RS256 署名済み JWT を作る。
 * 結果は assertion として OAuth2 token endpoint に送る用途。
 */
export async function buildJwtAssertion(
  key: GcpServiceAccountKey,
  scope: string,
  nowSec: number,
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: key.private_key_id };
  const payload = {
    iss: key.client_email,
    scope,
    aud: key.token_uri ?? TOKEN_ENDPOINT,
    iat: nowSec,
    exp: nowSec + JWT_LIFETIME_SEC,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(key.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * SA 鍵で OAuth2 access token を取得する。read-only スコープ。
 * 取得した token は呼び出し元で使い切る (キャッシュしない)。
 */
export async function fetchAccessToken(
  key: GcpServiceAccountKey,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const assertion = await buildJwtAssertion(key, SCOPE, nowSec);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch(key.token_uri ?? TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new GcpApiError(
      res.status,
      `GCP token exchange ${res.status}: ${text}`,
    );
  }
  const json = (await res.json()) as TokenResponse;
  return json.access_token;
}

interface GcpSecretRaw {
  name: string;
  createTime?: string;
  /** GCP Secret Manager にはトップレベルの updateTime はない (version-level) */
  labels?: Record<string, string>;
  topics?: Array<{ name: string }>;
  rotation?: Record<string, unknown>;
}

interface ListSecretsResponse {
  secrets?: GcpSecretRaw[];
  nextPageToken?: string;
}

/**
 * GCP Secret Manager の secret 一覧をメタデータのみで返す。
 * viewer ロールでは値の `accessSecretVersion` は構造的に呼べないため、本関数
 * 自身で値を取れる経路は無い。
 *
 * - `name` フィールドは `projects/{project}/secrets/{name}` の full path を
 *   `{name}` だけに整形して返す
 * - 100 件超は pageToken で続行
 */
export async function listGcpSecrets(ctx: GcpContext): Promise<SecretMetadata[]> {
  const token = await fetchAccessToken(ctx.serviceAccountKey);
  const out: SecretMetadata[] = [];
  let pageToken: string | undefined;
  let safetyCounter = 0;

  do {
    const url = new URL(
      `${SECRET_MANAGER_API}/projects/${encodeURIComponent(ctx.projectId)}/secrets`,
    );
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "secrets-inventory",
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new GcpApiError(
        res.status,
        `GCP Secret Manager ${res.status}: ${text}`,
      );
    }

    const json = (await res.json()) as ListSecretsResponse;
    for (const s of json.secrets ?? []) {
      out.push({
        name: shortName(s.name),
        created_at: s.createTime ?? null,
        extra: {
          labels: s.labels ?? {},
        },
      });
    }

    pageToken = json.nextPageToken;
    safetyCounter += 1;
    if (safetyCounter > 100) {
      throw new GcpApiError(
        500,
        "GCP Secret Manager pagination exceeded 100 pages — aborting",
      );
    }
  } while (pageToken);

  return out;
}

/** `projects/p/secrets/foo` → `foo`。突合のキーは短縮名で扱う。 */
export function shortName(fullName: string): string {
  const idx = fullName.lastIndexOf("/");
  return idx >= 0 ? fullName.slice(idx + 1) : fullName;
}
