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
  GCP_PROJECT_ID: "cloudsql-sv",
  GCP_PROXY_URL: "https://secrets-inventory-gcp-stub.run.app",
  GCP_PROXY_API_KEY: mockSecret("shared-secret-test"),
  SNAPSHOT_KV: {} as KVNamespace,
  MCP_SERVER_NAME: "secrets-inventory-read-mcp",
  MCP_SERVER_VERSION: "0.0.1",
  MCP_PROTOCOL_VERSION: "2025-03-26",
  AUTH_WORKER_ORIGIN: "https://auth.invalid",
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

describe("GET /api/gcp/secrets", () => {
  it("returns GCP secrets list shape via Cloud Run proxy", async () => {
    // proxy main.go は {"secrets": [...]} envelope + 各 item は created_at
    // ですでに short name (`projects/.../secrets/` prefix 剥離済み) で返す。
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        secrets: [
          {
            name: "STRIPE_API_KEY",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    const app = buildApp();
    const res = await app.request("/api/gcp/secrets", {}, baseEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      provider: string;
      secrets: { name: string }[];
    };
    expect(body.provider).toBe("gcp");
    expect(body.secrets[0]?.name).toBe("STRIPE_API_KEY");
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://secrets-inventory-gcp-stub.run.app/list-secrets",
    );
  });
});

describe("GET /api/all (partial success)", () => {
  it("returns per-provider results and surfaces errors without failing", async () => {
    // CF と GCP は成功、GitHub だけ 429 で落とす
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
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
      if (url.includes("secrets-inventory-gcp-stub.run.app")) {
        return Response.json({
          secrets: [
            { name: "GCP1", created_at: "2026-01-01T00:00:00Z" },
          ],
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const app = buildApp();
    const res = await app.request("/api/all", {}, baseEnv);
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
