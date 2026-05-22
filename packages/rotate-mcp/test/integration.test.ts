import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  type JWTVerifyGetKey,
} from "jose";
import type { Env, AppVariables, SecretsStoreSecret } from "../src/types";
import { cfAccessMiddleware } from "../src/middleware/cf-access";
import { bearerMiddleware } from "../src/middleware/bearer";
import {
  streamableHttpPost,
  legacySseGet,
  legacySsePost,
} from "../src/mcp/transport";
import { _resetJwksCacheForTests } from "../src/middleware/cf-access";

// CF Access の jwksOverride を差し込んだ end-to-end の組み立てテスト。
// `src/index.ts` の app そのものは createRemoteJWKSet を呼ぶため worker runtime
// 外では使えない。ここでは同じ middleware と route 構成を test 内で再現する。

const TEAM = "myteam.cloudflareaccess.com";
const AUD = "abcdef0123456789";
const ISSUER = `https://${TEAM}`;
const KID = "test-kid";

const BEARER = "test-bearer-value";

let privateKey: CryptoKey;
let jwks: JWTVerifyGetKey;

function mockSecret(value: string): SecretsStoreSecret {
  return { get: async () => value };
}

const env: Env = {
  CF_ACCESS_TEAM_DOMAIN: TEAM,
  CF_ACCESS_AUD: AUD,
  MCP_SERVER_NAME: "secrets-rotate-mcp",
  MCP_SERVER_VERSION: "0.0.1",
  MCP_PROTOCOL_VERSION: "2025-03-26",
  ROTATE_MCP_BEARER: mockSecret(BEARER),
};

beforeEach(async () => {
  _resetJwksCacheForTests();
  const generated = await generateKeyPair("RS256", { extractable: true });
  privateKey = generated.privateKey as CryptoKey;
  const exported = await exportJWK(generated.publicKey as CryptoKey);
  jwks = createLocalJWKSet({
    keys: [{ ...exported, kid: KID, alg: "RS256", use: "sig" }],
  });
});

async function signJwt(): Promise<string> {
  return await new SignJWT({ email: "op@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.get("/health", (c) =>
    c.json({
      ok: true,
      name: c.env.MCP_SERVER_NAME,
      version: c.env.MCP_SERVER_VERSION,
      protocol: c.env.MCP_PROTOCOL_VERSION,
    }),
  );
  app.use("/mcp/*", cfAccessMiddleware(jwks));
  app.use("/mcp/*", bearerMiddleware());
  app.post("/mcp", streamableHttpPost);
  app.get("/mcp/sse", legacySseGet);
  app.post("/mcp/sse/message", legacySsePost);
  app.all("/mcp/*", (c) => c.json({ error: "not found" }, 404));
  return app;
}

describe("/health", () => {
  it("returns server info without auth", async () => {
    const app = buildApp();
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      name: "secrets-rotate-mcp",
      version: "0.0.1",
      protocol: "2025-03-26",
    });
  });
});

describe("POST /mcp (Streamable HTTP)", () => {
  it("rejects when CF Access JWT missing", async () => {
    const app = buildApp();
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${BEARER}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects when bearer is wrong", async () => {
    const app = buildApp();
    const jwt = await signJwt();
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          Authorization: "Bearer wrong",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns initialize result with both auth headers", async () => {
    const app = buildApp();
    const jwt = await signJwt();
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          Authorization: `Bearer ${BEARER}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe("secrets-rotate-mcp");
  });

  it("returns 400 + parse_error on invalid JSON", async () => {
    const app = buildApp();
    const jwt = await signJwt();
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          Authorization: `Bearer ${BEARER}`,
          "Content-Type": "application/json",
        },
        body: "{",
      },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("returns 202 for notification (no id)", async () => {
    const app = buildApp();
    const jwt = await signJwt();
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          Authorization: `Bearer ${BEARER}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
      },
      env,
    );
    expect(res.status).toBe(202);
  });

  it("calls rotate_secret tool end-to-end", async () => {
    const app = buildApp();
    const jwt = await signJwt();
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          Authorization: `Bearer ${BEARER}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "rotate_secret",
            arguments: {
              name: "MY_SECRET",
              new_value: "TOP-SECRET-V",
              confirm_name: "MY_SECRET",
              targets: ["gcp"],
            },
          },
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // 値が response body に一切現れない
    expect(body).not.toContain("TOP-SECRET-V");
  });
});

describe("GET /mcp/sse (Legacy SSE)", () => {
  it("returns SSE stream with endpoint event", async () => {
    const app = buildApp();
    const jwt = await signJwt();
    const res = await app.request(
      "/mcp/sse",
      {
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          Authorization: `Bearer ${BEARER}`,
        },
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("X-MCP-Session-Id")).toBeTruthy();
    const text = await res.text();
    expect(text).toMatch(/event: endpoint/);
    expect(text).toMatch(/data: \/mcp\/sse\/message\?session=/);
  });
});

describe("POST /mcp/sse/message (Legacy SSE)", () => {
  it("handles JSON-RPC request and returns JSON response", async () => {
    const app = buildApp();
    const jwt = await signJwt();
    const res = await app.request(
      "/mcp/sse/message",
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          Authorization: `Bearer ${BEARER}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.length).toBe(2);
  });

  it("returns 400 on parse error", async () => {
    const app = buildApp();
    const jwt = await signJwt();
    const res = await app.request(
      "/mcp/sse/message",
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          Authorization: `Bearer ${BEARER}`,
          "Content-Type": "application/json",
        },
        body: "{",
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 202 on notification", async () => {
    const app = buildApp();
    const jwt = await signJwt();
    const res = await app.request(
      "/mcp/sse/message",
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          Authorization: `Bearer ${BEARER}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
      },
      env,
    );
    expect(res.status).toBe(202);
  });
});

describe("unknown /mcp/* path", () => {
  it("returns 404", async () => {
    const app = buildApp();
    const jwt = await signJwt();
    const res = await app.request(
      "/mcp/nope",
      {
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          Authorization: `Bearer ${BEARER}`,
        },
      },
      env,
    );
    expect(res.status).toBe(404);
  });
});
