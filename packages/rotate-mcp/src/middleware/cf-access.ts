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

const jwksCache = new Map<string, JWTVerifyGetKey>();

function getJwks(teamDomain: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    const url = new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
    jwks = createRemoteJWKSet(url);
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

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
      const claims = await verifyCfAccessJwtWithJwks(token, jwks, {
        teamDomain,
        audience,
      });
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

export function defaultJwksResolver(teamDomain: string): JWTVerifyGetKey {
  return getJwks(teamDomain);
}

export function _resetJwksCacheForTests(): void {
  jwksCache.clear();
}

export function getCfAccessClaims(c: Context): CfAccessClaims | undefined {
  return c.get("cfAccess") as CfAccessClaims | undefined;
}
