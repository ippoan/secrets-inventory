import type { Context, MiddlewareHandler } from "hono";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

// secrets-inventory/src/middleware/cf-access.ts の sibling 実装。
// Phase A では monorepo workspace の shared package を切らないため複製している。
// 仕様変更があれば両方同時に追従する必要がある。

export interface CfAccessClaims extends JWTPayload {
  email?: string;
  identity_nonce?: string;
}

interface CfAccessConfig {
  teamDomain: string;
  audience: string;
}

/**
 * teamDomain → JWKS key resolver を返す factory。test では mock resolver を
 * 注入できるよう、middleware は resolver 自身を引数で受け取る (middleware 内に
 * fallback 分岐を残さない)。
 */
export type JwksResolver = (teamDomain: string) => JWTVerifyGetKey;

const jwksCache = new Map<string, JWTVerifyGetKey>();

/**
 * 本番用 resolver。teamDomain ごとに `createRemoteJWKSet` を 1 度だけ生成して
 * Worker isolate のライフタイム中だけキャッシュする。
 */
export const defaultJwksResolver: JwksResolver = (teamDomain) => {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    const url = new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
    jwks = createRemoteJWKSet(url);
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
};

/**
 * `Cf-Access-Jwt-Assertion` ヘッダーを検証し、`c.set("cfAccess", claims)` に
 * デコード済み claims を載せる Hono middleware。
 *
 * 本番では `defaultJwksResolver` を渡し、test では closure で localJWKSet を
 * 返す resolver を渡す。
 */
export function cfAccessMiddleware(
  jwksResolver: JwksResolver,
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
      const jwks = jwksResolver(teamDomain);
      const claims = await verifyCfAccessJwtWithJwks(token, jwks, {
        teamDomain,
        audience,
      });
      c.set("cfAccess", claims);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        { error: `CF Access JWT verification failed: ${message}` },
        401,
      );
    }

    await next();
  };
}

export async function verifyCfAccessJwtWithJwks(
  token: string,
  jwks: JWTVerifyGetKey,
  config: CfAccessConfig,
): Promise<CfAccessClaims> {
  const { payload } = await jwtVerify(token, jwks, {
    audience: config.audience,
    issuer: `https://${config.teamDomain}`,
  });
  return payload as CfAccessClaims;
}

export function _resetJwksCacheForTests(): void {
  jwksCache.clear();
}

export function getCfAccessClaims(c: Context): CfAccessClaims | undefined {
  return c.get("cfAccess") as CfAccessClaims | undefined;
}
