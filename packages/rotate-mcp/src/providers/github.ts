// GitHub Actions org secrets provider: PUT /orgs/{org}/actions/secrets/{name}
//
// GitHub org secrets は **libsodium sealed box (Curve25519 + XSalsa20-Poly1305
// + blake2b nonce)** で encrypt 必須:
//   1. GET /orgs/{org}/actions/secrets/public-key で org public key (base64
//      Curve25519) + key_id を取得
//   2. sealed box (NaCl crypto_box_seal 相当) で encrypt
//   3. PUT /orgs/{org}/actions/secrets/{name} に
//      `{ encrypted_value: base64, key_id, visibility }` を送る
//
// Workers Runtime の WebCrypto は Curve25519 を直接 export しないため pure-JS
// 実装に依存。tweetnacl + tweetnacl-sealedbox-js (両方とも依存ゼロ / pure JS /
// Workers 互換 / 合計 ~40 KB) を採用。tweetnacl-sealedbox-js は libsodium の
// crypto_box_seal pattern (ephemeral keypair + blake2b nonce) を正しく再現
// した実装で、tested + 普及している。
//
// 値そのものは PUT body にしか乗らず、log / response には絶対に echo しない。

import nacl from "tweetnacl";
// @ts-expect-error - tweetnacl-sealedbox-js は型定義を持たない
import sealedbox from "tweetnacl-sealedbox-js";

import type { Env, RotateSecretProviderResult } from "../types";

const GITHUB_API = "https://api.github.com";

export interface GhRotateArgs {
  name: string;
  newValue: string;
  /** PUT body の `visibility` 上書き (省略時は API default = `all`)。 */
  visibility?: "all" | "private" | "selected";
}

export interface GhDeps {
  env: Env;
  fetcher?: typeof fetch;
}

interface GhPublicKeyResponse {
  key_id: string;
  key: string;
}

/**
 * Public key 取得 → sealed box → PUT。失敗は status="fail" で返す
 * (throw しない = 並列実行の他 provider を巻き込まない)。
 */
export async function rotateGithub(
  args: GhRotateArgs,
  deps: GhDeps,
): Promise<RotateSecretProviderResult> {
  const { env } = deps;
  const fetcher = deps.fetcher ?? fetch;
  const token = await env.GITHUB_PAT.get();

  const org = encodeURIComponent(env.GITHUB_ORG);
  const name = encodeURIComponent(args.name);

  // step 1: public key
  let pkRes: Response;
  try {
    pkRes = await fetcher(`${GITHUB_API}/orgs/${org}/actions/secrets/public-key`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "secrets-rotate-mcp",
      },
    });
  } catch (err) {
    return {
      status: "fail",
      error: `github public-key network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!pkRes.ok) {
    const body = (await pkRes.text()).slice(0, 200);
    return { status: "fail", error: `github public-key ${pkRes.status}: ${body}` };
  }

  let pk: GhPublicKeyResponse;
  try {
    pk = (await pkRes.json()) as GhPublicKeyResponse;
  } catch (err) {
    return {
      status: "fail",
      error: `github public-key bad json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof pk.key !== "string" || typeof pk.key_id !== "string") {
    return { status: "fail", error: "github public-key missing key / key_id" };
  }

  // step 2: encrypt with libsodium sealed box
  let encryptedB64: string;
  try {
    encryptedB64 = sealedBoxEncrypt(args.newValue, pk.key);
  } catch (err) {
    return {
      status: "fail",
      error: `github encrypt: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // step 3: PUT secret
  let putRes: Response;
  try {
    putRes = await fetcher(`${GITHUB_API}/orgs/${org}/actions/secrets/${name}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "secrets-rotate-mcp",
      },
      body: JSON.stringify({
        encrypted_value: encryptedB64,
        key_id: pk.key_id,
        visibility: args.visibility ?? "all",
      }),
    });
  } catch (err) {
    return {
      status: "fail",
      error: `github put network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // PUT returns 201 Created (new secret) or 204 No Content (update)
  if (putRes.status !== 201 && putRes.status !== 204) {
    const body = (await putRes.text()).slice(0, 200);
    return { status: "fail", error: `github put ${putRes.status}: ${body}` };
  }

  return { status: "ok" };
}

/**
 * GitHub org secret 用の sealed box encrypt。tweetnacl-sealedbox-js が
 * libsodium の crypto_box_seal を pure JS で再現している (Curve25519 +
 * XSalsa20-Poly1305 + blake2b nonce)。input は UTF-8 文字列、output は
 * base64 (GitHub API 仕様)。
 */
export function sealedBoxEncrypt(plaintext: string, recipientPublicKeyB64: string): string {
  const recipientPk = base64ToBytes(recipientPublicKeyB64);
  if (recipientPk.length !== nacl.box.publicKeyLength) {
    throw new Error(
      `invalid public key length: ${recipientPk.length} (expected ${nacl.box.publicKeyLength})`,
    );
  }
  const message = new TextEncoder().encode(plaintext);
  const sealed: Uint8Array = sealedbox.seal(message, recipientPk);
  return bytesToBase64(sealed);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ===========================================================================
// create_secret 用
// ===========================================================================

export interface GhCreateArgs {
  name: string;
  initialValue: string;
  /** false で既存 secret 再利用 (PUT は冪等)。default true (= 409). */
  failIfExists?: boolean;
  visibility?: "all" | "private" | "selected";
}

export interface GhCreateResult extends RotateSecretProviderResult {
  /** 新規作成 = true、既存上書き = false (fail_if_exists=false で再利用時)。 */
  created?: boolean;
}

/**
 * GitHub Actions org secret 新規作成。GitHub の `PUT` は冪等で create + update
 * の両方を兼ねるため、failIfExists=true のときだけ事前 `GET /actions/secrets/
 * {name}` で 404 確認を入れる:
 *   - 404 → 存在しない → PUT で create、created=true
 *   - 200 → 既存 → status="fail" + "already exists"
 *   - その他 → status="fail" (auth / network)
 *
 * failIfExists=false なら GET 飛ばして即 PUT (= 上書き)、created=false。
 */
export async function createGithub(
  args: GhCreateArgs,
  deps: GhDeps,
): Promise<GhCreateResult> {
  const { env } = deps;
  const fetcher = deps.fetcher ?? fetch;
  const token = await env.GITHUB_PAT.get();

  const org = encodeURIComponent(env.GITHUB_ORG);
  const name = encodeURIComponent(args.name);
  const failIfExists = args.failIfExists ?? true;

  // step 1: 既存確認 (failIfExists=true のみ)
  if (failIfExists) {
    let getRes: Response;
    try {
      getRes = await fetcher(`${GITHUB_API}/orgs/${org}/actions/secrets/${name}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "secrets-rotate-mcp",
        },
      });
    } catch (err) {
      return {
        status: "fail",
        error: `github get network error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (getRes.status === 200) {
      return { status: "fail", error: "github secret already exists" };
    }
    if (getRes.status !== 404) {
      const body = (await getRes.text()).slice(0, 200);
      return { status: "fail", error: `github get ${getRes.status}: ${body}` };
    }
  }

  // step 2: PUT (rotateGithub と同じ encrypt + put 処理)
  const result = await rotateGithub(
    {
      name: args.name,
      newValue: args.initialValue,
      visibility: args.visibility,
    },
    deps,
  );
  if (result.status !== "ok") return result;
  return { ...result, created: failIfExists };
}
