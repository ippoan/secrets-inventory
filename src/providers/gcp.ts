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
 * Cloud Run proxy (ippoan/secrets-inventory-gcp) が返す raw shape。
 * proxy 側 main.go の出力形式に合わせる。
 */
interface ProxyRawSecret {
  name: string;
  create_time?: string;
  labels?: Record<string, string>;
}

/**
 * GCP Secret Manager のメタデータ list を Cloud Run proxy 経由で取得する。
 *
 * Worker は GCP credentials を一切持たず、proxy への shared secret header
 * 認証のみで叩く。proxy 側で ADC 経由 (Cloud Run attached SA) に変換され、
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

  const raw = (await res.json()) as ProxyRawSecret[];
  return raw.map((s) => ({
    name: shortName(s.name),
    created_at: s.create_time ?? null,
    extra: {
      labels: s.labels ?? {},
    },
  }));
}

/** `projects/p/secrets/foo` → `foo`。proxy 側でも parse 済みかもしれないが念のため。 */
export function shortName(fullName: string): string {
  const idx = fullName.lastIndexOf("/");
  return idx >= 0 ? fullName.slice(idx + 1) : fullName;
}
