import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

// `SecretsStoreSecret` は @cloudflare/workers-types で declare global されている
// ambient type なので import 不要。

// `Authorization: Bearer <token>` を Secrets Store binding `INVENTORY_MCP_BEARER`
// と timing-safe 比較する。read MCP は CF Access (人間判定) の **上に** 載る
// tool-call 単位の二重認証で、AI client を identify + rate limit / audit key
// として機能する。
//
// read MCP は機密値そのものを返さない (= metadata のみ) ので Bearer の
// blast radius は rotate-mcp より小さいが、CF Access が突破された時の
// defense in depth + client 識別のために必須にしている。Bearer 値は
// secrets-rotate-mcp の `ROTATE_MCP_BEARER` とは別物 (= 失効時の影響を分離)。

const SCHEME_PREFIX = "Bearer ";

/**
 * 与えられた 2 つの文字列を constant-time で比較する。SHA-256 でハッシュ化
 * してから XOR で diff を取るため、true / false の判定そのものは leak しない。
 * 値長 (= ハッシュ前の入力長) も観測されにくくなる副次効果がある。
 */
async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const hashA = new Uint8Array(
    await crypto.subtle.digest("SHA-256", enc.encode(a)),
  );
  const hashB = new Uint8Array(
    await crypto.subtle.digest("SHA-256", enc.encode(b)),
  );
  let diff = 0;
  for (let i = 0; i < hashA.length; i++) {
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
 * - Secrets Store binding 未設定 / get() throw / 空値 → 503 (fail-closed)
 * - token mismatch → 401 (Bearer 値そのものは log / response に出さない)
 */
export function bearerMiddleware(
  options: BearerMiddlewareOptions = {},
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const header = c.req.header("Authorization");
    if (!header || !header.startsWith(SCHEME_PREFIX)) {
      return c.json(
        { error: "missing or malformed Authorization: Bearer header" },
        401,
      );
    }
    const provided = header.slice(SCHEME_PREFIX.length);

    const binding = options.expectedBearer ?? c.env.INVENTORY_MCP_BEARER;
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
      const message = err instanceof Error ? err.message : String(err);
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

    await next();
  };
}
