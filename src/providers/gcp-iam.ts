// Cloud Run proxy (ippoan/secrets-inventory-gcp) `/list-service-accounts` の
// client。Worker は GCP credentials を一切持たず、proxy への shared secret
// header 認証のみで叩く。proxy 側で ADC (Cloud Run attached SA + `roles/
// iam.securityReviewer`) に変換され、IAM Admin / Resource Manager API へ。

export class GcpIamProxyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GcpIamProxyError";
  }
}

export interface GcpIamProxyContext {
  proxyUrl: string;
  apiKey: string;
}

export type SaKeyType = "USER_MANAGED" | "SYSTEM_MANAGED" | "KEY_TYPE_UNSPECIFIED";

export interface SaKey {
  id: string;
  key_type: SaKeyType;
  valid_after?: string;
  valid_before?: string;
}

export interface ServiceAccount {
  email: string;
  display_name?: string;
  description?: string;
  unique_id: string;
  disabled: boolean;
  roles: string[];
  keys: SaKey[];
}

interface ProxyRawKey {
  id: string;
  key_type: string;
  valid_after?: string;
  valid_before?: string;
}

interface ProxyRawSa {
  email: string;
  display_name?: string;
  description?: string;
  unique_id: string;
  disabled: boolean;
  roles?: string[];
  keys?: ProxyRawKey[];
}

interface ProxyListResponse {
  service_accounts?: ProxyRawSa[];
}

/**
 * proxy 経由で project の全 service account inventory を取得する。
 * keys に `PrivateKeyData` 系の field が混入していた場合は **絶対に**
 * worker 側まで透過させない (= defense in depth)。proxy 側で除外済み + ここ
 * でも `SaKey` の型を絞ることで二重防御。
 */
export async function listServiceAccounts(
  ctx: GcpIamProxyContext,
): Promise<ServiceAccount[]> {
  const res = await fetch(`${ctx.proxyUrl}/list-service-accounts`, {
    method: "GET",
    headers: {
      "X-Inventory-API-Key": ctx.apiKey,
      Accept: "application/json",
      "User-Agent": "secrets-inventory",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new GcpIamProxyError(
      res.status,
      `GCP IAM proxy ${res.status}: ${body}`,
    );
  }
  const raw = (await res.json()) as ProxyListResponse;
  return (raw.service_accounts ?? []).map(toServiceAccount);
}

function toServiceAccount(s: ProxyRawSa): ServiceAccount {
  return {
    email: s.email,
    display_name: s.display_name,
    description: s.description,
    unique_id: s.unique_id,
    disabled: s.disabled,
    roles: s.roles ?? [],
    keys: (s.keys ?? []).map((k) => ({
      id: k.id,
      key_type: normalizeKeyType(k.key_type),
      valid_after: k.valid_after,
      valid_before: k.valid_before,
    })),
  };
}

function normalizeKeyType(s: string): SaKeyType {
  if (s === "USER_MANAGED" || s === "SYSTEM_MANAGED") return s;
  return "KEY_TYPE_UNSPECIFIED";
}
