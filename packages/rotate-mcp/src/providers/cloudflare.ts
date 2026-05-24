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

// ===========================================================================
// create_secret 用
// ===========================================================================

export interface CfCreateArgs {
  name: string;
  initialValue: string;
  /** false で既存 secret 再利用 (PATCH に切り替え)。default true (= 409). */
  failIfExists?: boolean;
  /** CF Secrets Store scopes (e.g. ["workers"])。default = ["workers"]。 */
  scopes?: string[];
}

export interface CfCreateResult extends RotateSecretProviderResult {
  /** 新規作成 = true、既存再利用 = false。 */
  created?: boolean;
}

interface CfCreatedSecret {
  id: string;
  name: string;
}

/**
 * CF Secrets Store の新規 secret 作成:
 *   POST /accounts/{account_id}/secrets_store/stores/{store_id}/secrets
 *
 * failIfExists の semantics (rotate-mcp 側で実装):
 *   1) まず list で既存有無を確認
 *   2) 既存有 + failIfExists=true → status="fail" + "already exists"
 *      既存有 + failIfExists=false → PATCH 経路 (= 既存 rotateCloudflare 相当) で
 *      値だけ更新、created=false で返す
 *      既存無 → POST 経路で create
 *
 * CF API は CreateSecret 失敗時の error code が安定していないので、
 * list-then-create 方式で確実に判定する (= rotateCloudflare の name→id
 * lookup と同パターン)。
 */
export async function createCloudflare(
  args: CfCreateArgs,
  deps: CfDeps,
): Promise<CfCreateResult> {
  const { env } = deps;
  const fetcher = deps.fetcher ?? fetch;

  const token = await env.CF_API_TOKEN.get();
  const base = `${CF_API}/accounts/${env.CF_ACCOUNT_ID}/secrets_store/stores/${env.CF_STORE_ID}/secrets`;

  const failIfExists = args.failIfExists ?? true;

  // step 1: list で既存判定
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

  const existing = listEnv.result.find((s) => s.name === args.name);

  if (existing) {
    if (failIfExists) {
      return { status: "fail", error: "cf secret already exists" };
    }
    // 既存再利用: PATCH で値だけ更新 (rotateCloudflare と同じ経路)
    let patchRes: Response;
    try {
      patchRes = await fetcher(`${base}/${existing.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "secrets-rotate-mcp",
        },
        body: JSON.stringify({ value: args.initialValue }),
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
    return { status: "ok", secret_id: existing.id, created: false };
  }

  // step 2: 新規 POST
  // CF Secrets Store の POST body: { name, value, scopes? }。scopes default は
  // CF API 側で `[]` だが、Worker から使う前提では `["workers"]` が現実的。
  const scopes = args.scopes ?? ["workers"];
  let postRes: Response;
  try {
    postRes = await fetcher(base, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "secrets-rotate-mcp",
      },
      body: JSON.stringify({ name: args.name, value: args.initialValue, scopes }),
    });
  } catch (err) {
    return {
      status: "fail",
      error: `cf post network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!postRes.ok) {
    const body = (await postRes.text()).slice(0, 200);
    return { status: "fail", error: `cf post ${postRes.status}: ${body}` };
  }
  let postEnv: CfEnvelope<CfCreatedSecret | CfCreatedSecret[]>;
  try {
    postEnv = (await postRes.json()) as CfEnvelope<CfCreatedSecret | CfCreatedSecret[]>;
  } catch (err) {
    return {
      status: "fail",
      error: `cf post bad json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!postEnv.success) {
    const msg = (postEnv.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    return { status: "fail", error: `cf post error: ${msg || "unknown"}` };
  }

  // CF API は result が単体 or 配列 (1 要素) で返ることがあるので両対応
  const created = Array.isArray(postEnv.result) ? postEnv.result[0] : postEnv.result;
  if (!created || typeof created.id !== "string") {
    return { status: "fail", error: "cf post returned no id" };
  }

  return { status: "ok", secret_id: created.id, created: true };
}
