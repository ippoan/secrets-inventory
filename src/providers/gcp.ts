import type { SecretMetadata } from "../types";

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
}

/**
 * Cloud Run proxy (ippoan/secrets-inventory-gcp) `main.go` の `secretItem`
 * と 1:1 対応。`name` は proxy 側で `projects/.../secrets/` prefix を剥がした
 * 短縮名で来るが、Worker 側でも shortName() を idempotent にかけて防御する。
 */
interface ProxyRawSecret {
  name: string;
  created_at?: string;
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
