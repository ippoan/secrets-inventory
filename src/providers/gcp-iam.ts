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
  /**
   * Policy Analyzer (`serviceAccountLastAuthentication`) が観測した最終認証時刻
   * (RFC3339)。proxy 側で空文字なら "観測期間中認証なし" / "Policy Analyzer 失敗"
   * / "API 未有効" のいずれか — Worker 側からは区別不能 (全部 undefined)。
   *
   * 値の精度は GCP 側で日次粒度に丸められる (内部的に T07:00:00Z 等で出ることが
   * docs にある) ため、UI 側では "N 日前" 表示で扱う。
   */
  last_authenticated_at?: string;
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
  last_authenticated_at?: string;
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
    // proxy が空文字を送ってくる "no data" ケースを undefined に正規化 (UI 側で
    // `s.last_authenticated_at ?? "—"` の判定が 1 統で済む)。
    last_authenticated_at: s.last_authenticated_at ? s.last_authenticated_at : undefined,
  };
}

function normalizeKeyType(s: string): SaKeyType {
  if (s === "USER_MANAGED" || s === "SYSTEM_MANAGED") return s;
  return "KEY_TYPE_UNSPECIFIED";
}
