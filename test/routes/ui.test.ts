import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { handleDashboard } from "../../src/routes/ui";
import type { Env } from "../../src/types";

function mockSecret(value: string): SecretsStoreSecret {
  return { get: async () => value } as unknown as SecretsStoreSecret;
}

function makeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string, opts?: unknown) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      if (opts === "json" || (opts as { type?: string })?.type === "json") {
        return JSON.parse(raw);
      }
      return raw;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}

const baseEnv: Env = {
  CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  CF_ACCESS_AUD: "aud",
  CF_ACCOUNT_ID: "acc",
  CF_STORE_ID: "store",
  CF_API_TOKEN: mockSecret("cf-tok"),
  GITHUB_ORG: "ippoan",
  GITHUB_PAT: mockSecret("gh-tok"),
  GCP_PROJECT_ID: "cloudsql-sv",
  GCP_PROXY_URL: "https://gcp-stub.run.app",
  GCP_PROXY_API_KEY: mockSecret("shared"),
  SNAPSHOT_KV: makeKv(),
  MCP_SERVER_NAME: "secrets-inventory-read-mcp",
  MCP_SERVER_VERSION: "0.0.1",
  MCP_PROTOCOL_VERSION: "2025-03-26",
  AUTH_WORKER_ORIGIN: "https://auth.invalid",
};

/**
 * 本 handler は `src/index.ts` で root `/` に直接マウントされる。テストでも
 * 同じ mount で叩いて挙動を確認する。CF Access middleware はここではテスト
 * せず (cf-access.test.ts 側の責務)、handler 単独の HTML 出力だけ見る。
 */
function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/", handleDashboard);
  return app;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET / (dashboard)", () => {
  it("returns 200 + HTML with content-type text/html", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://gcp-stub.run.app")) {
        return Response.json({
          secrets: [{ name: "STRIPE_API_KEY", created_at: "2026-01-01T00:00:00Z" }],
        });
      }
      if (url.startsWith("https://api.github.com")) {
        return Response.json({ total_count: 0, secrets: [] });
      }
      if (url.startsWith("https://api.cloudflare.com")) {
        return Response.json({ success: true, result: [] });
      }
      return new Response("?", { status: 500 });
    });
    const env = { ...baseEnv, SNAPSHOT_KV: makeKv() };
    const res = await buildApp().request("/", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")?.toLowerCase()).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("STRIPE_API_KEY");
  });

  it("returns 502 HTML when GCP fails (UI is still served, just with an error)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://gcp-stub.run.app")) {
        return new Response("upstream gone", { status: 502 });
      }
      return Response.json({});
    });
    const env = { ...baseEnv, SNAPSHOT_KV: makeKv() };
    const res = await buildApp().request("/", {}, env);
    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain("GCP fetch failed");
  });

  it("?commit=1 reflects snapshot update in the rendered HTML", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://gcp-stub.run.app")) {
        return Response.json({
          secrets: [{ name: "A", created_at: "2026-01-01T00:00:00Z" }],
        });
      }
      if (url.startsWith("https://api.github.com")) {
        return Response.json({ total_count: 0, secrets: [] });
      }
      if (url.startsWith("https://api.cloudflare.com")) {
        return Response.json({ success: true, result: [] });
      }
      return new Response("?", { status: 500 });
    });
    const env = { ...baseEnv, SNAPSHOT_KV: makeKv() };
    const res = await buildApp().request("/?commit=1", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/snapshot を .* で更新しました/);
  });
});
