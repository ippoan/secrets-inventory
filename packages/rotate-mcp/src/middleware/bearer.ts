import type { MiddlewareHandler } from "hono";
import type { Env, AppVariables, SecretsStoreSecret } from "../types";

// `Authorization: Bearer <token>` を Secrets Store binding `ROTATE_MCP_BEARER`
// と timing-safe 比較する。CF Access の人間判定の **上に** 載る tool-call 単位
// の二重認証 (operator が browser で auth flow を通した後、MCP client が tool を
// 呼び出す時の identifier)。
//
// Phase A は middleware 骨格のみ。Bearer 実値の 30 日 rotation は Phase B 以降で
// `rotate_secret` の dogfooding (= 自分の bearer を自分で rotate) として実装。
// それまでは手動 rotation で運用。

const SCHEME_PREFIX = "Bearer ";

/**
 * 与えられた 2 つの文字列を constant-time で比較する。length が違う場合は
 * 即 false で返るが、true / false の判定そのものは leak しない。
 * 値長 + 等価判定の両方が attacker から timing 観測されないよう、内部では
 * `crypto.subtle.digest` で hash 化してから比較する。
 */
async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const hashA = new Uint8Array(
    await crypto.subtle.digest("SHA-256", enc.encode(a)),
  );
  const hashB = new Uint8Array(
    await crypto.subtle.digest("SHA-256", enc.encode(b)),
  );
  let diff = hashA.length === hashB.length ? 0 : 1;
  const len = Math.min(hashA.length, hashB.length);
  for (let i = 0; i < len; i++) {
    diff |= hashA[i]! ^ hashB[i]!;
  }
  return diff === 0;
}

export interface BearerMiddlewareOptions {
  /** テスト用 override。本番は Secrets Store binding を使う。 */
  expectedBearer?: SecretsStoreSecret;
}

/**
 * `Authorization: Bearer <token>` を検証する Hono middleware。
 *
 * - header 欠落 / scheme 不正 → 401
 * - Secrets Store binding 未設定 → 503 (fail-closed)
 * - token mismatch → 401 (Bearer 値そのものは log / response に出さない)
 *
 * 成功時は `c.set("bearerVerified", true)` を立てる。
 */
export function bearerMiddleware(
  options: BearerMiddlewareOptions = {},
): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> {
  return async (c, next) => {
    // Hono / fetch API は header value を trim するため、`Authorization: Bearer`
    // (token 不在) は `SCHEME_PREFIX = "Bearer "` の prefix match に失敗してここで
    // 弾かれる。trailing whitespace 単独の token は実質発生しない。
    const header = c.req.header("Authorization");
    if (!header || !header.startsWith(SCHEME_PREFIX)) {
      return c.json(
        { error: "missing or malformed Authorization: Bearer header" },
        401,
      );
    }
    const provided = header.slice(SCHEME_PREFIX.length);

    const binding = options.expectedBearer ?? c.env.ROTATE_MCP_BEARER;
    if (!binding || typeof binding.get !== "function") {
      return c.json(
        { error: "Bearer secret binding not configured" },
        503,
      );
    }

    let expected: string;
    try {
      expected = await binding.get();
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      return c.json(
        { error: `Bearer secret read failed: ${message}` },
        503,
      );
    }

    if (!expected || expected.length === 0) {
      return c.json(
        { error: "Bearer secret is empty (not provisioned)" },
        503,
      );
    }

    const ok = await constantTimeEquals(provided, expected);
    if (!ok) {
      return c.json({ error: "invalid bearer token" }, 401);
    }

    c.set("bearerVerified", true);
    await next();
  };
}
