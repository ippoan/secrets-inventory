import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  cfAccessMiddleware,
  verifyCfAccessJwtWithJwks,
  getCfAccessClaims,
  defaultJwksResolver,
  _resetJwksCacheForTests,
} from "../../src/middleware/cf-access";
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  type JWTVerifyGetKey,
} from "jose";

const TEAM = "myteam.cloudflareaccess.com";
const AUD = "abcdef0123456789";
const ISSUER = `https://${TEAM}`;
const KID = "test-kid";

let privateKey: CryptoKey;
let jwks: JWTVerifyGetKey;

beforeEach(async () => {
  _resetJwksCacheForTests();
  const generated = await generateKeyPair("RS256", { extractable: true });
  privateKey = generated.privateKey as CryptoKey;
  const exported = await exportJWK(generated.publicKey as CryptoKey);
  jwks = createLocalJWKSet({
    keys: [{ ...exported, kid: KID, alg: "RS256", use: "sig" }],
  });
});

async function signTestJwt(payload: Record<string, unknown>): Promise<string> {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("verifyCfAccessJwtWithJwks", () => {
  it("accepts a valid JWT", async () => {
    const jwt = await signTestJwt({ email: "user@example.com" });
    const claims = await verifyCfAccessJwtWithJwks(jwt, jwks, {
      teamDomain: TEAM,
      audience: AUD,
    });
    expect(claims.email).toBe("user@example.com");
    expect(claims.iss).toBe(ISSUER);
    expect(claims.aud).toBe(AUD);
  });

  it("rejects wrong audience", async () => {
    const jwt = await signTestJwt({ email: "user@example.com" });
    await expect(
      verifyCfAccessJwtWithJwks(jwt, jwks, {
        teamDomain: TEAM,
        audience: "WRONG_AUD",
      }),
    ).rejects.toThrow();
  });

  it("rejects garbage", async () => {
    await expect(
      verifyCfAccessJwtWithJwks("not-a-jwt", jwks, {
        teamDomain: TEAM,
        audience: AUD,
      }),
    ).rejects.toThrow();
  });

  it("rejects JWT signed by an unknown key", async () => {
    const other = await generateKeyPair("RS256", { extractable: true });
    const jwt = await new SignJWT({ email: "user@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "other-kid" })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(other.privateKey as CryptoKey);
    await expect(
      verifyCfAccessJwtWithJwks(jwt, jwks, { teamDomain: TEAM, audience: AUD }),
    ).rejects.toThrow();
  });
});

describe("cfAccessMiddleware in Hono", () => {
  const env = {
    CF_ACCESS_TEAM_DOMAIN: TEAM,
    CF_ACCESS_AUD: AUD,
  };

  function buildApp() {
    const app = new Hono<{
      Bindings: typeof env;
      Variables: { cfAccess: { email?: string } };
    }>();
    app.use("/api/*", cfAccessMiddleware(jwks));
    app.get("/api/me", (c) => {
      const claims = getCfAccessClaims(c);
      return c.json({ email: claims?.email ?? null });
    });
    return app;
  }

  it("rejects when header is missing", async () => {
    const app = buildApp();
    const res = await app.request("/api/me", {}, env);
    expect(res.status).toBe(401);
  });

  it("rejects when JWT is invalid", async () => {
    const app = buildApp();
    const res = await app.request(
      "/api/me",
      { headers: { "Cf-Access-Jwt-Assertion": "garbage" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("populates claims on success", async () => {
    const app = buildApp();
    const jwt = await signTestJwt({ email: "user@example.com" });
    const res = await app.request(
      "/api/me",
      { headers: { "Cf-Access-Jwt-Assertion": jwt } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "user@example.com" });
  });

  it("returns 500 when team domain / audience are missing", async () => {
    const app = buildApp();
    const res = await app.request(
      "/api/me",
      {},
      { CF_ACCESS_TEAM_DOMAIN: "", CF_ACCESS_AUD: "" },
    );
    expect(res.status).toBe(500);
  });
});

describe("defaultJwksResolver", () => {
  it("returns a JWKS resolver for the given team domain", () => {
    const resolver = defaultJwksResolver(TEAM);
    expect(typeof resolver).toBe("function");
  });

  it("returns claims undefined when c.get is missing", () => {
    // Hono Context のないインスタンスで明示的に呼ぶケースは type 上想定外だが、
    // null-safe path (= undefined 返し) を覚えさせるためのカバレッジ。
    const fakeContext = {
      get: (_k: string) => undefined,
    } as unknown as import("hono").Context;
    expect(getCfAccessClaims(fakeContext)).toBeUndefined();
  });
});
