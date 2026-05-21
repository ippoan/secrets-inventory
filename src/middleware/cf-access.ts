import type { Context, MiddlewareHandler } from "hono";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export interface CfAccessClaims extends JWTPayload {
  email?: string;
  /** Cloudflare Access が発行する identity nonce */
  identity_nonce?: string;
}

interface CfAccessConfig {
  teamDomain: string;
  audience: string;
}

/**
 * teamDomain ごとに JWKS resolver をキャッシュする。
 * Worker isolate のライフタイム中だけ持つので、新しい team domain に切り替わって
 * もメモリリークにはならない。
 */
const jwksCache = new Map<string, JWTVerifyGetKey>();

function getJwks(teamDomain: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    const url = new URL(
      `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`,
    );
    jwks = createRemoteJWKSet(url);
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

/**
 * `Cf-Access-Jwt-Assertion` ヘッダーを検証し、`c.set("cfAccess", claims)` に
 * デコード済み claims を載せる Hono middleware。
 *
 * - JWT が無い / 検証失敗 → 401 (Cloudflare Access 経由のリクエストでない)
 * - aud / iss が config と一致しない → 401
 *
 * 本番では Worker route 自体を Cloudflare Access で保護する前提だが、念のため
 * Worker 内でも検証する (defense in depth)。
 *
 * テスト時は `jwksOverride` で `createLocalJWKSet` 等を差し込める。本番からは
 * 渡さない (`undefined` の場合は team domain から `createRemoteJWKSet` する)。
 */
export function cfAccessMiddleware(
  jwksOverride?: JWTVerifyGetKey,
): MiddlewareHandler<{
  Bindings: {
    CF_ACCESS_TEAM_DOMAIN: string;
    CF_ACCESS_AUD: string;
  };
  Variables: { cfAccess: CfAccessClaims };
}> {
  return async (c, next) => {
    const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN;
    const audience = c.env.CF_ACCESS_AUD;

    if (!teamDomain || !audience) {
      return c.json(
        { error: "CF Access misconfigured: team domain or audience missing" },
        500,
      );
    }

    const token = c.req.header("Cf-Access-Jwt-Assertion");
    if (!token) {
      return c.json({ error: "missing Cf-Access-Jwt-Assertion" }, 401);
    }

    try {
      const jwks = jwksOverride ?? getJwks(teamDomain);
      const claims = await verifyCfAccessJwtWithJwks(
        token,
        jwks,
        { teamDomain, audience },
      );
      c.set("cfAccess", claims);
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid jwt";
      return c.json(
        { error: `CF Access JWT verification failed: ${message}` },
        401,
      );
    }

    await next();
  };
}

/**
 * 指定 JWKS resolver で JWT を検証し payload を返す。`createRemoteJWKSet`
 * (本番) でも `createLocalJWKSet` (テスト) でも同じシグネチャで使える。
 */
export async function verifyCfAccessJwtWithJwks(
  token: string,
  jwks: JWTVerifyGetKey,
  config: CfAccessConfig,
): Promise<CfAccessClaims> {
  const { payload } = await jwtVerify(token, jwks, {
    audience: config.audience,
    issuer: `https://${config.teamDomain}.cloudflareaccess.com`,
  });
  return payload as CfAccessClaims;
}

/** team domain からデフォルト (remote) の JWKS resolver を取得する */
export function defaultJwksResolver(teamDomain: string): JWTVerifyGetKey {
  return getJwks(teamDomain);
}

/** テスト用: isolate メモリのキャッシュをクリアする */
export function _resetJwksCacheForTests(): void {
  jwksCache.clear();
}

/**
 * Cloudflare 標準の `getContext` 補助。テストや上位で `c.get("cfAccess")` を
 * 型付きで取り出すのに使う。
 */
export function getCfAccessClaims(c: Context): CfAccessClaims | undefined {
  return c.get("cfAccess") as CfAccessClaims | undefined;
}
