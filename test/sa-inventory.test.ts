import { describe, it, expect, vi, afterEach } from "vitest";
import { gatherSaInventory, GcpIamUnavailableError } from "../src/sa-inventory";
import { GcpIamProxyError } from "../src/providers/gcp-iam";
import type { Env } from "../src/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function mkEnv(): Env {
  return {
    CF_ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com",
    CF_ACCESS_AUD: "aud",
    CF_ACCOUNT_ID: "acc",
    CF_STORE_ID: "store",
    GITHUB_ORG: "ippoan",
    GCP_PROJECT_ID: "cloudsql-sv",
    GCP_PROXY_URL: "https://proxy.example",
    GCP_PROXY_API_KEY: { get: async () => "api-key" } as Env["GCP_PROXY_API_KEY"],
    SNAPSHOT_KV: {} as KVNamespace,
    MCP_SERVER_NAME: "secrets-inventory-read-mcp",
    MCP_SERVER_VERSION: "0.0.1",
    MCP_PROTOCOL_VERSION: "2025-03-26",
    AUTH_WORKER_ORIGIN: "https://auth.invalid",
    AUTH_WORKER: { fetch: async () => new Response(null, { status: 501 }) } as unknown as Fetcher,
    MCP_DO: {} as unknown as DurableObjectNamespace,
  };
}

describe("gatherSaInventory", () => {
  it("calls proxy, sorts rows candidate -> warn -> ok, computes summary", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        service_accounts: [
          // ok
          {
            email: "sa-ok@p.iam.gserviceaccount.com",
            unique_id: "1",
            disabled: false,
            roles: ["roles/foo"],
            keys: [],
          },
          // candidate (no-role + stale-auth = 真に dead な candidate per #29)
          {
            email: "sa-norole@p.iam.gserviceaccount.com",
            unique_id: "2",
            disabled: false,
            roles: [],
            keys: [],
            last_authenticated_at: "2025-01-01T00:00:00Z", // 1 年以上前
          },
          // warn (default-sa)
          {
            email: "9999-compute@developer.gserviceaccount.com",
            unique_id: "3",
            disabled: false,
            roles: ["roles/editor"],
            keys: [],
          },
        ],
      }),
    );

    const res = await gatherSaInventory(mkEnv());
    expect(res.gcp_project_id).toBe("cloudsql-sv");
    expect(res.rows).toHaveLength(3);
    expect(res.rows[0]!.audit.status).toBe("candidate");
    expect(res.rows[1]!.audit.status).toBe("warn");
    expect(res.rows[2]!.audit.status).toBe("ok");
    expect(res.summary).toEqual({ total: 3, ok: 1, warn: 1, candidate: 1 });
  });

  it("sorts alphabetically within same status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        service_accounts: [
          { email: "z@p.iam.gserviceaccount.com", unique_id: "1", disabled: false, roles: ["roles/foo"], keys: [] },
          { email: "a@p.iam.gserviceaccount.com", unique_id: "2", disabled: false, roles: ["roles/foo"], keys: [] },
        ],
      }),
    );
    const res = await gatherSaInventory(mkEnv());
    expect(res.rows[0]!.sa.email).toBe("a@p.iam.gserviceaccount.com");
    expect(res.rows[1]!.sa.email).toBe("z@p.iam.gserviceaccount.com");
  });

  it("wraps GcpIamProxyError into GcpIamUnavailableError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream down", { status: 502 }),
    );
    await expect(gatherSaInventory(mkEnv())).rejects.toBeInstanceOf(
      GcpIamUnavailableError,
    );
  });

  it("wraps generic Error into GcpIamUnavailableError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    await expect(gatherSaInventory(mkEnv())).rejects.toBeInstanceOf(
      GcpIamUnavailableError,
    );
    await expect(gatherSaInventory(mkEnv())).rejects.toThrow(/network/);
  });

  it("wraps non-Error throw into GcpIamUnavailableError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue("string-error");
    await expect(gatherSaInventory(mkEnv())).rejects.toThrow(/string-error/);
  });

  it("instances of GcpIamProxyError go through the specific branch", async () => {
    // GcpIamProxyError は GcpIamUnavailableError に変換される
    const err = new GcpIamProxyError(503, "explicit proxy err");
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw err;
    });
    await expect(gatherSaInventory(mkEnv())).rejects.toThrow(/explicit proxy err/);
  });
});
