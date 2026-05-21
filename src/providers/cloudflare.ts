import type { SecretMetadata } from "../types";

const CF_API = "https://api.cloudflare.com/client/v4";

export interface CfContext {
  token: string;
  accountId: string;
  storeId: string;
}

export class CloudflareApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

interface CfEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
}

export async function cfApi<T>(
  ctx: CfContext,
  method: string,
  path: string,
): Promise<T> {
  const res = await fetch(`${CF_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: "application/json",
      "User-Agent": "secrets-inventory",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new CloudflareApiError(
      res.status,
      `Cloudflare API ${res.status}: ${body}`,
    );
  }

  const json = (await res.json()) as CfEnvelope<T>;
  if (!json.success) {
    const msg = (json.errors ?? [])
      .map((e) => `${e.code}: ${e.message}`)
      .join("; ");
    throw new CloudflareApiError(
      res.status,
      `Cloudflare API error: ${msg || "unknown"}`,
    );
  }
  return json.result;
}

export function secretsStorePath(ctx: CfContext, suffix = ""): string {
  return `/accounts/${ctx.accountId}/secrets_store/stores/${ctx.storeId}/secrets${suffix}`;
}

interface CfSecretRaw {
  id: string;
  name: string;
  comment?: string | null;
  scopes?: string[] | null;
  status?: string | null;
  created?: string | null;
  modified?: string | null;
}

/**
 * Cloudflare Secrets Store の secret 一覧をメタデータのみで返す。
 * 値は API がそもそも返さないため、構造的に流出しない。
 */
export async function listCloudflareSecrets(
  ctx: CfContext,
): Promise<SecretMetadata[]> {
  const raw = await cfApi<CfSecretRaw[]>(ctx, "GET", secretsStorePath(ctx));
  return raw.map((s) => ({
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
