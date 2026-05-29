import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { inventoryRoutes } from "../../src/routes/inventory";
import type { Env } from "../../src/types";
import { SNAPSHOT_KEY } from "../../src/snapshot";

function mockSecret(value: string): SecretsStoreSecret {
  return { get: async () => value } as unknown as SecretsStoreSecret;
}

function makeKv(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));
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
  GITHUB_ORG: "ippoan",
  GCP_PROJECT_ID: "cloudsql-sv",
  GCP_PROXY_URL: "https://gcp-stub.run.app",
  GCP_PROXY_API_KEY: mockSecret("shared"),
  SNAPSHOT_KV: makeKv(),
  MCP_SERVER_NAME: "secrets-inventory-read-mcp",
  MCP_SERVER_VERSION: "0.0.1",
  MCP_PROTOCOL_VERSION: "2025-03-26",
  AUTH_WORKER_ORIGIN: "https://auth.invalid",
  MCP_DO: {} as unknown as DurableObjectNamespace,
};

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api", inventoryRoutes);
  return app;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/inventory", () => {
  it("returns 200 + reconciled body when all providers OK", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/list-secrets")) {
        return Response.json({
          secrets: [{ name: "STRIPE_API_KEY", created_at: "2026-01-01T00:00:00Z" }],
        });
      }
      if (url.includes("/gh/secrets")) {
        return Response.json({ secrets: [] });
      }
      if (url.includes("/cf/secrets")) {
        return Response.json({ secrets: [] });
      }
      return new Response("?", { status: 500 });
    });
    const env = { ...baseEnv, SNAPSHOT_KV: makeKv() };
    const res = await buildApp().request("/api/inventory", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      gcp_project_id: string;
      rows: { name: string }[];
      snapshot_committed: boolean;
    };
    expect(body.gcp_project_id).toBe("cloudsql-sv");
    expect(body.rows[0]?.name).toBe("STRIPE_API_KEY");
    expect(body.snapshot_committed).toBe(false);
  });

  it("?commit=1 writes a fresh snapshot to KV", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/list-secrets")) {
        return Response.json({
          secrets: [{ name: "A", created_at: "2026-01-01T00:00:00Z" }],
        });
      }
      if (url.includes("/gh/secrets")) {
        return Response.json({ secrets: [] });
      }
      if (url.includes("/cf/secrets")) {
        return Response.json({ secrets: [] });
      }
      return new Response("?", { status: 500 });
    });
    const kv = makeKv();
    const env = { ...baseEnv, SNAPSHOT_KV: kv };
    const res = await buildApp().request("/api/inventory?commit=1", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshot_committed: boolean };
    expect(body.snapshot_committed).toBe(true);

    // 直接 KV を読み直して書き込みを確認
    const stored = await kv.get(SNAPSHOT_KEY, "json");
    expect((stored as { names: string[] }).names).toEqual(["A"]);
  });

  it("returns 502 when GCP fetch fails (source of truth)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/list-secrets")) {
        return new Response("upstream", { status: 503 });
      }
      return Response.json({});
    });
    const env = { ...baseEnv, SNAPSHOT_KV: makeKv() };
    const res = await buildApp().request("/api/inventory", {}, env);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/GCP fetch failed/);
  });

  it("returns 200 with errors.github when only GitHub fails (partial)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/list-secrets")) {
        return Response.json({
          secrets: [{ name: "A", created_at: "2026-01-01T00:00:00Z" }],
        });
      }
      if (url.includes("/gh/secrets")) {
        return new Response("unauth", { status: 401 });
      }
      if (url.includes("/cf/secrets")) {
        return Response.json({ secrets: [] });
      }
      return new Response("?", { status: 500 });
    });
    const env = { ...baseEnv, SNAPSHOT_KV: makeKv() };
    const res = await buildApp().request("/api/inventory", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: { in_github: boolean | null }[];
      errors: { github?: string };
    };
    expect(body.rows[0]?.in_github).toBeNull();
    expect(body.errors.github).toMatch(/401/);
  });
});
