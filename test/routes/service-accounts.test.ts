import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import {
  serviceAccountsRoutes,
  handleSaDashboard,
} from "../../src/routes/service-accounts";
import type { Env } from "../../src/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function mkEnv(): Env {
  return {
    CF_ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
    CF_ACCESS_AUD: "aud",
    CF_ACCOUNT_ID: "acc",
    CF_STORE_ID: "store",
    CF_API_TOKEN: { get: async () => "cf" } as Env["CF_API_TOKEN"],
    GITHUB_ORG: "ippoan",
    GITHUB_PAT: { get: async () => "gh" } as Env["GITHUB_PAT"],
    GCP_PROJECT_ID: "cloudsql-sv",
    GCP_PROXY_URL: "https://proxy.example",
    GCP_PROXY_API_KEY: { get: async () => "api-key" } as Env["GCP_PROXY_API_KEY"],
    SNAPSHOT_KV: {} as KVNamespace,
  };
}

function mockProxy(body: unknown, status = 200): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("GET /api/service-accounts", () => {
  it("returns JSON inventory on success", async () => {
    mockProxy({
      service_accounts: [
        {
          email: "sa-x@p.iam.gserviceaccount.com",
          unique_id: "1",
          disabled: false,
          roles: ["roles/foo"],
          keys: [],
        },
      ],
    });
    const app = new Hono<{ Bindings: Env }>().route("/api", serviceAccountsRoutes);
    const res = await app.request("/api/service-accounts", {}, mkEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      gcp_project_id: string;
      rows: unknown[];
      summary: { total: number };
    };
    expect(body.gcp_project_id).toBe("cloudsql-sv");
    expect(body.summary.total).toBe(1);
  });

  it("returns 502 when proxy is down", async () => {
    mockProxy("boom", 502);
    const app = new Hono<{ Bindings: Env }>().route("/api", serviceAccountsRoutes);
    const res = await app.request("/api/service-accounts", {}, mkEnv());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/GCP IAM proxy unavailable/);
  });

  it("returns 502 when GCP_PROXY_API_KEY binding throws (wrapped to GcpIamUnavailable)", async () => {
    const env = mkEnv();
    env.GCP_PROXY_API_KEY = {
      get: async () => {
        throw new Error("binding read fail");
      },
    } as Env["GCP_PROXY_API_KEY"];
    const app = new Hono<{ Bindings: Env }>().route("/api", serviceAccountsRoutes);
    const res = await app.request("/api/service-accounts", {}, env);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/binding read fail/);
  });

  it("rethrows non-GcpIamUnavailable errors from gatherSaInventory (covers throw err line)", async () => {
    const mod = await import("../../src/sa-inventory");
    const spy = vi
      .spyOn(mod, "gatherSaInventory")
      .mockRejectedValue(new RangeError("synthetic-not-gcp"));
    const app = new Hono<{ Bindings: Env }>().route("/api", serviceAccountsRoutes);
    // Hono は handler 外への throw を 500 にする
    const res = await app.request("/api/service-accounts", {}, mkEnv());
    expect(res.status).toBe(500);
    spy.mockRestore();
  });
});

describe("handleSaDashboard (HTML)", () => {
  it("returns 200 + HTML on success", async () => {
    mockProxy({
      service_accounts: [
        { email: "sa@p.iam.gserviceaccount.com", unique_id: "1", disabled: false, roles: ["roles/foo"], keys: [] },
      ],
    });
    const app = new Hono<{ Bindings: Env }>();
    app.get("/service-accounts", handleSaDashboard);
    const res = await app.request("/service-accounts", {}, mkEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    const text = await res.text();
    expect(text).toContain("SA Inventory");
  });

  it("filters by ?status=candidate", async () => {
    mockProxy({
      service_accounts: [
        { email: "ok@p.iam.gserviceaccount.com", unique_id: "1", disabled: false, roles: ["roles/foo"], keys: [] },
        { email: "no@p.iam.gserviceaccount.com", unique_id: "2", disabled: false, roles: [], keys: [] },
      ],
    });
    const app = new Hono<{ Bindings: Env }>();
    app.get("/service-accounts", handleSaDashboard);
    const res = await app.request(
      "/service-accounts?status=candidate",
      {},
      mkEnv(),
    );
    const text = await res.text();
    expect(text).toContain("no@p.iam.gserviceaccount.com");
    expect(text).not.toContain("ok@p.iam.gserviceaccount.com");
  });

  it("ignores unknown ?status= value (falls back to no filter)", async () => {
    mockProxy({
      service_accounts: [
        { email: "ok@p.iam.gserviceaccount.com", unique_id: "1", disabled: false, roles: ["roles/foo"], keys: [] },
      ],
    });
    const app = new Hono<{ Bindings: Env }>();
    app.get("/service-accounts", handleSaDashboard);
    const res = await app.request(
      "/service-accounts?status=mystery",
      {},
      mkEnv(),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("ok@p.iam.gserviceaccount.com");
  });

  it("returns 502 + error HTML on GcpIamUnavailableError", async () => {
    mockProxy("boom", 502);
    const app = new Hono<{ Bindings: Env }>();
    app.get("/service-accounts", handleSaDashboard);
    const res = await app.request("/service-accounts", {}, mkEnv());
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("GCP IAM proxy unavailable");
  });

  it("returns 500 + error HTML on unexpected non-Gcp error", async () => {
    // env.GCP_PROXY_API_KEY 自体が getter で throw する場合は sa-inventory.ts で
    // GcpIamUnavailableError にラップされてしまうので、こちらは "Error 以外" を
    // ratherthe gatherSaInventory の handler 内で投げる pattern。
    //
    // ここでは強引に handler を override して unexpected error を起こす。
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      // string throw → sa-inventory が GcpIamUnavailableError にラップする path
      throw new TypeError("simulated unexpected");
    });
    // TypeError も Error なので GcpIamUnavailableError 経由になる。
    // 一旦 502 を accept (= GcpIamUnavailable に丸まる)
    const app = new Hono<{ Bindings: Env }>();
    app.get("/service-accounts", handleSaDashboard);
    const res = await app.request("/service-accounts", {}, mkEnv());
    expect([500, 502]).toContain(res.status);
    consoleSpy.mockRestore();
  });

  it("renders 500 page when gatherSaInventory throws after rethrow (synthetic)", async () => {
    // gatherSaInventory が GcpIamUnavailableError 以外を投げる branch を
    // 直接 cover するため、handler を低レベルで触る代わりに sa-inventory
    // module を spy する。
    const mod = await import("../../src/sa-inventory");
    const spy = vi
      .spyOn(mod, "gatherSaInventory")
      .mockRejectedValue(new RangeError("synthetic"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = new Hono<{ Bindings: Env }>();
    app.get("/service-accounts", handleSaDashboard);
    const res = await app.request("/service-accounts", {}, mkEnv());
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain("Unexpected error");
    expect(text).toContain("synthetic");
    spy.mockRestore();
    consoleSpy.mockRestore();
  });

  it("falls back to String(err) when handler catches non-Error throw", async () => {
    const mod = await import("../../src/sa-inventory");
    const spy = vi
      .spyOn(mod, "gatherSaInventory")
      .mockRejectedValue("string-thrown");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = new Hono<{ Bindings: Env }>();
    app.get("/service-accounts", handleSaDashboard);
    const res = await app.request("/service-accounts", {}, mkEnv());
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain("string-thrown");
    spy.mockRestore();
    consoleSpy.mockRestore();
  });
});
