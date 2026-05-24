import type { Env, RotateSecretProviderResult } from "../types";

// Cloudflare Secrets Store provider: CF API を直接叩いて secret 値を更新する。
//
// CF Secrets Store の write 経路は 2 段:
//   1. GET /accounts/.../secrets_store/stores/{store_id}/secrets?per_page=...
//      で全 secret list を取得 → 名前 → secret_id を解決
//   2. PATCH /accounts/.../secrets_store/stores/{store_id}/secrets/{secret_id}
//      に `{ value: "<new>" }` を送る
//
// secret_id が判らないと PATCH できないが、CF API は name-keyed lookup を直接
// 提供していないため list 経由になる (= O(N) per rotation。N=O(数十) なので
// 許容)。値そのものは log にも response にも echo しない。

const CF_API = "https://api.cloudflare.com/client/v4";

export interface CfRotateArgs {
  name: string;
  newValue: string;
}

export interface CfDeps {
  env: Env;
  fetcher?: typeof fetch;
}

interface CfEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
}

interface CfSecretListItem {
  id: string;
  name: string;
}

/**
 * 1) list secrets → name で filter → secret_id を解決
 * 2) PATCH /secrets/{secret_id} で値を更新
 *
 * 失敗時は status="fail" で throw せず返す (= 並列実行の他 provider を巻き
 * 込まない)。
 */
export async function rotateCloudflare(
  args: CfRotateArgs,
  deps: CfDeps,
): Promise<RotateSecretProviderResult> {
  const { env } = deps;
  const fetcher = deps.fetcher ?? fetch;

  const token = await env.CF_API_TOKEN.get();
  const base = `${CF_API}/accounts/${env.CF_ACCOUNT_ID}/secrets_store/stores/${env.CF_STORE_ID}/secrets`;

  // step 1: list で id を解決
  let listRes: Response;
  try {
    listRes = await fetcher(`${base}?per_page=1000`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "secrets-rotate-mcp",
      },
    });
  } catch (err) {
    return {
      status: "fail",
      error: `cf list network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!listRes.ok) {
    const body = (await listRes.text()).slice(0, 200);
    return { status: "fail", error: `cf list ${listRes.status}: ${body}` };
  }

  let listEnv: CfEnvelope<CfSecretListItem[]>;
  try {
    listEnv = (await listRes.json()) as CfEnvelope<CfSecretListItem[]>;
  } catch (err) {
    return {
      status: "fail",
      error: `cf list bad json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!listEnv.success) {
    const msg = (listEnv.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    return { status: "fail", error: `cf list error: ${msg || "unknown"}` };
  }

  const target = listEnv.result.find((s) => s.name === args.name);
  if (!target) {
    return { status: "fail", error: `cf secret not found: ${args.name}` };
  }

  // step 2: PATCH 値更新
  let patchRes: Response;
  try {
    patchRes = await fetcher(`${base}/${target.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "secrets-rotate-mcp",
      },
      body: JSON.stringify({ value: args.newValue }),
    });
  } catch (err) {
    return {
      status: "fail",
      error: `cf patch network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!patchRes.ok) {
    const body = (await patchRes.text()).slice(0, 200);
    return { status: "fail", error: `cf patch ${patchRes.status}: ${body}` };
  }

  // PATCH response body は使わないが、JSON parse して success=true を確認
  let patchEnv: CfEnvelope<unknown>;
  try {
    patchEnv = (await patchRes.json()) as CfEnvelope<unknown>;
  } catch {
    // body が空 or 不正 JSON でも 2xx なら ok 扱い (CF API の挙動に頑健に)
    return { status: "ok", secret_id: target.id };
  }
  if (!patchEnv.success) {
    const msg = (patchEnv.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    return { status: "fail", error: `cf patch error: ${msg || "unknown"}` };
  }

  return { status: "ok", secret_id: target.id };
}
