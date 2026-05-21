import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { listRoutes } from "../../src/routes/list";
import type { Env } from "../../src/types";

/**
 * routes/list は middleware を通さない素の Hono router として直接 mount する。
 * 認証は cfAccessMiddleware の責務なので、ここでは provider 呼び出しの統合だけ
 * 確認する。
 */

function mockSecret(value: string): SecretsStoreSecret {
  return { get: async () => value } as unknown as SecretsStoreSecret;
}

const baseEnv: Env = {
  CF_ACCESS_TEAM_DOMAIN: "team",
  CF_ACCESS_AUD: "aud",
  CF_ACCOUNT_ID: "acc",
  CF_STORE_ID: "store",
  CF_API_TOKEN: mockSecret("cf-tok"),
  GITHUB_ORG: "ippoan",
  GITHUB_PAT: mockSecret("gh-tok"),
  GCP_PROJECT_ID: "p",
  GCP_SA_KEY: mockSecret(
    JSON.stringify({
      type: "service_account",
      client_email: "x@y.iam.gserviceaccount.com",
      private_key: "k",
    }),
  ),
  SNAPSHOT_KV: {} as KVNamespace,
};

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api", listRoutes);
  return app;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/cloudflare/secrets", () => {
  it("returns CF secrets list shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        success: true,
        result: [{ id: "id-1", name: "A" }],
      }),
    );
    const app = buildApp();
    const res = await app.request("/api/cloudflare/secrets", {}, baseEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      provider: string;
      secrets: { name: string }[];
    };
    expect(body.provider).toBe("cloudflare");
    expect(body.secrets[0]?.name).toBe("A");
  });
});

describe("GET /api/github/secrets", () => {
  it("returns GitHub secrets list shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        total_count: 1,
        secrets: [
          {
            name: "PAT",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            visibility: "all",
          },
        ],
      }),
    );
    const app = buildApp();
    const res = await app.request("/api/github/secrets", {}, baseEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      provider: string;
      secrets: { name: string }[];
    };
    expect(body.provider).toBe("github");
    expect(body.secrets[0]?.name).toBe("PAT");
  });
});

describe("GET /api/all (partial success)", () => {
  it("returns per-provider results and surfaces errors without failing", async () => {
    // GCP token + GCP list + CF list を成功させ、GitHub だけ 500 で落とす
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.cloudflare.com")) {
        return Response.json({
          success: true,
          result: [{ id: "id-1", name: "CF1" }],
        });
      }
      if (url.includes("api.github.com")) {
        return new Response("rate limited", { status: 429 });
      }
      if (url.includes("oauth2.googleapis.com")) {
        return Response.json({
          access_token: "ya29.fake",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (url.includes("secretmanager.googleapis.com")) {
        return Response.json({
          secrets: [
            { name: "projects/p/secrets/GCP1", createTime: "2026-01-01T00:00:00Z" },
          ],
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    // GCP SA key の JWT 署名は実 RSA 鍵がないと作れないので、その経路は通らない
    // ように `GCP_SA_KEY` を実 RSA SA key に差し替える。
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pkcs8 = (await crypto.subtle.exportKey(
      "pkcs8",
      pair.privateKey,
    )) as ArrayBuffer;
    const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
    const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----\n`;
    const realKey = {
      ...baseEnv,
      GCP_SA_KEY: mockSecret(
        JSON.stringify({
          type: "service_account",
          private_key_id: "kid",
          private_key: pem,
          client_email: "sa@p.iam.gserviceaccount.com",
        }),
      ),
    };

    const app = buildApp();
    const res = await app.request("/api/all", {}, realKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cloudflare: { secrets?: { name: string }[]; error?: string };
      github: { secrets?: { name: string }[]; error?: string };
      gcp: { secrets?: { name: string }[]; error?: string };
    };
    expect(body.cloudflare.secrets?.[0]?.name).toBe("CF1");
    expect(body.gcp.secrets?.[0]?.name).toBe("GCP1");
    expect(body.github.error).toMatch(/429/);
  });
});
