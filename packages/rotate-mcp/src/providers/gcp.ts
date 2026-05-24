import type { Env, RotateSecretProviderResult } from "../types";

// GCP provider: secrets-inventory-gcp Cloud Run proxy 経由で
// `POST /add-version?name=<n>` を叩く。proxy が ADC で Secret Manager に
// AddSecretVersion を委譲。Worker 自身は GCP credential を持たない (= shared
// API key だけ送る) ので、CF Secrets Store binding 経由で `GCP_PROXY_API_KEY`
// を受け取る。
//
// 値は body の `value` field のみで運び、log / response に echo しない。
// proxy 側でも同様に enforce している (= ippoan/secrets-inventory-gcp PR #23)。

export interface GcpRotateArgs {
  name: string;
  newValue: string;
  /** TOCTOU 検証用の現 latest version id (= shortName)。省略可。 */
  expectedVersionId?: string;
  /** actor email (audit log 用)。省略可。 */
  actorEmail?: string;
}

export interface GcpDeps {
  env: Env;
  /** test 注入用。本番は global `fetch`。 */
  fetcher?: typeof fetch;
}

interface ProxyAddVersionResponse {
  ok: boolean;
  new_version: string;
}

/**
 * `POST /add-version` を呼び、provider 結果を返す。
 *
 * 失敗時は status="fail" + error (HTTP status + body 先頭) を返し、throw しない。
 * caller (executeRotateSecret) は全 provider の結果を Promise.allSettled 的に
 * 集約するため。値そのものは error message に絶対に含めない。
 */
export async function rotateGcp(
  args: GcpRotateArgs,
  deps: GcpDeps,
): Promise<RotateSecretProviderResult> {
  const { env } = deps;
  const fetcher = deps.fetcher ?? fetch;

  const apiKey = await env.GCP_PROXY_API_KEY.get();
  const url = `${env.GCP_PROXY_URL}/add-version?name=${encodeURIComponent(args.name)}`;

  const headers: Record<string, string> = {
    "X-Inventory-API-Key": apiKey,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "secrets-rotate-mcp",
  };
  if (args.actorEmail) headers["X-Actor-Email"] = args.actorEmail;
  if (args.expectedVersionId) headers["X-Expected-Version-Id"] = args.expectedVersionId;

  let res: Response;
  try {
    res = await fetcher(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ value: args.newValue }),
    });
  } catch (err) {
    return {
      status: "fail",
      error: `network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    // body の冒頭だけ拾う (= 値 echo の二次防御。proxy が generic "upstream error"
    // 等を返す前提だが、念のため 200 chars で切る)。
    const body = (await res.text()).slice(0, 200);
    return {
      status: "fail",
      error: `gcp proxy ${res.status}: ${body}`,
    };
  }

  let parsed: ProxyAddVersionResponse;
  try {
    parsed = (await res.json()) as ProxyAddVersionResponse;
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
  };
}
