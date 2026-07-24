import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { gatherInventory, GcpUnavailableError } from "../src/inventory";
import type { Env } from "../src/types";
import { SNAPSHOT_KEY } from "../src/snapshot";

function mockSecret(value: string): SecretsStoreSecret {
  return { get: async () => value } as unknown as SecretsStoreSecret;
}

function makeKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const put = vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  });
  const get = vi.fn(async (key: string, opts?: unknown) => {
    const raw = store.get(key);
    if (raw === undefined) return null;
    if (opts === "json" || (opts as { type?: string })?.type === "json") {
      return JSON.parse(raw);
    }
    return raw;
  });
  return {
    kv: { get, put } as unknown as KVNamespace,
    store,
    putSpy: put,
  };
}

// Refs #45: 3 provider すべて GCP Cloud Run proxy 経由になったため、
// `CF_API_TOKEN` / `GITHUB_PAT` の Secrets Store binding は Env から削除。
function makeEnv(kv: KVNamespace): Env {
  return {
    CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CF_ACCESS_AUD: "aud",
    CF_ACCOUNT_ID: "acc",
    CF_STORE_ID: "store",
    GITHUB_ORG: "ippoan",
    GCP_PROJECT_ID: "cloudsql-sv",
    GCP_PROXY_URL: "https://gcp-stub.run.app",
    GCP_PROXY_API_KEY: mockSecret("shared-secret"),
    SNAPSHOT_KV: kv,
    MCP_SERVER_NAME: "secrets-inventory-mcp",
    MCP_SERVER_VERSION: "0.0.2",
    MCP_PROTOCOL_VERSION: "2025-03-26",
    AUTH_WORKER_ORIGIN: "https://auth.invalid",
    AUTH_WORKER: { fetch: async () => new Response(null, { status: 501 }) } as unknown as Fetcher,
    MCP_DO: {} as unknown as DurableObjectNamespace,
  };
}

/**
 * fetch mock: proxy 経由になったので「同じ proxy URL を path で分岐」する。
 * - /list-secrets       → GCP
 * - /gh/secrets         → GitHub
 * - /cf/secrets         → Cloudflare
 *
 * (旧 mock は api.cloudflare.com / api.github.com を見ていた)
 */
function installFetchMock(handlers: {
  gcp?: () => Response;
  github?: () => Response;
  cloudflare?: () => Response;
  serviceTokens?: () => Response;
}) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.startsWith("https://gcp-stub.run.app")) {
      return new Response("unexpected: " + url, { status: 500 });
    }
    if (url.includes("/list-secrets")) {
      return handlers.gcp ? handlers.gcp() : Response.json({ secrets: [] });
    }
    if (url.includes("/gh/secrets")) {
      return handlers.github ? handlers.github() : Response.json({ secrets: [] });
    }
    // /cf/service-tokens を /cf/secrets より先に判定する (前者は後者を部分文字列に
    // 含まないが、意図を明示するため CF service token を先に分岐させる)。
    if (url.includes("/cf/service-tokens")) {
      return handlers.serviceTokens
        ? handlers.serviceTokens()
        : Response.json({ service_tokens: [] });
    }
    if (url.includes("/cf/secrets")) {
      return handlers.cloudflare ? handlers.cloudflare() : Response.json({ secrets: [] });
    }
    return new Response("unexpected path: " + url, { status: 500 });
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gatherInventory — happy path", () => {
  it("merges GCP / GitHub / CF and returns rows + diff vs snapshot", async () => {
    installFetchMock({
      gcp: () =>
        Response.json({
          secrets: [
            { name: "A", created_at: "2026-01-01T00:00:00Z" },
            { name: "B", created_at: "2026-02-01T00:00:00Z" },
            { name: "C", created_at: "2026-03-01T00:00:00Z" },
          ],
        }),
      github: () =>
        Response.json({
          secrets: [
            {
              name: "A",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
          ],
        }),
      cloudflare: () =>
        Response.json({
          secrets: [{ id: "id-b", name: "B" }],
        }),
    });
    const { kv } = makeKv({
      [SNAPSHOT_KEY]: JSON.stringify({
        v: 1,
        captured_at: "2026-05-20T00:00:00Z",
        names: ["A", "B"],
      }),
    });
    const env = makeEnv(kv);

    const result = await gatherInventory(env);

    expect(result.gcp_project_id).toBe("cloudsql-sv");
    expect(result.rows.map((r) => r.name)).toEqual(["A", "B", "C"]);
    const rowC = result.rows.find((r) => r.name === "C")!;
    expect(rowC.is_new_since_snapshot).toBe(true);
    expect(rowC.in_github).toBe(false);
    expect(rowC.in_cloudflare).toBe(false);
    expect(result.diff.added).toEqual(["C"]);
    expect(result.diff.removed).toEqual([]);
    expect(result.previous_snapshot_at).toBe("2026-05-20T00:00:00Z");
    expect(result.snapshot_committed).toBe(false);
    expect(result.errors).toEqual({});
  });
});

describe("gatherInventory — partial failures", () => {
  it("GitHub fail → in_github=null on every row + errors.github filled", async () => {
    installFetchMock({
      gcp: () =>
        Response.json({
          secrets: [{ name: "X", created_at: "2026-01-01T00:00:00Z" }],
        }),
      github: () => new Response("unauth", { status: 401 }),
    });
    const { kv } = makeKv();
    const result = await gatherInventory(makeEnv(kv));
    expect(result.rows[0]?.in_github).toBeNull();
    expect(result.rows[0]?.in_cloudflare).toBe(false);
    expect(result.errors.github).toMatch(/401/);
    expect(result.errors.cloudflare).toBeUndefined();
  });

  it("Cloudflare fail → in_cloudflare=null + errors.cloudflare filled", async () => {
    installFetchMock({
      gcp: () =>
        Response.json({
          secrets: [{ name: "X", created_at: "2026-01-01T00:00:00Z" }],
        }),
      cloudflare: () => new Response("forbidden", { status: 403 }),
    });
    const result = await gatherInventory(makeEnv(makeKv().kv));
    expect(result.rows[0]?.in_cloudflare).toBeNull();
    expect(result.errors.cloudflare).toMatch(/403/);
  });

  it("GCP fail → GcpUnavailableError (source of truth is required)", async () => {
    installFetchMock({
      gcp: () => new Response("upstream gone", { status: 502 }),
    });
    await expect(gatherInventory(makeEnv(makeKv().kv))).rejects.toBeInstanceOf(
      GcpUnavailableError,
    );
  });

  // Real-world failure mode: SecretsStoreSecret.get() can throw
  // "Secrets Worker: Failed to fetch secret" if the binding's secret name
  // hasn't been provisioned in the store. Refs #45 で worker が持つ binding は
  // `GCP_PROXY_API_KEY` の 1 個だけになったので、それが throw すると 3 provider
  // すべてが影響を受ける = GcpUnavailableError 経路に集約される (旧 CF/GH
  // 個別 throw test は廃止)。
  function throwingSecret(reason: string): SecretsStoreSecret {
    return {
      get: async () => {
        throw new Error(reason);
      },
    } as unknown as SecretsStoreSecret;
  }

  it("GCP_PROXY_API_KEY .get() throws → GcpUnavailableError (3 provider 共通 binding)", async () => {
    const env = makeEnv(makeKv().kv);
    env.GCP_PROXY_API_KEY = throwingSecret(
      "Secrets Worker: Failed to fetch secret",
    );
    await expect(gatherInventory(env)).rejects.toBeInstanceOf(
      GcpUnavailableError,
    );
  });
});

describe("gatherInventory — snapshot commit", () => {
  it("commitSnapshot:true writes the current GCP names + timestamp into KV", async () => {
    installFetchMock({
      gcp: () =>
        Response.json({
          secrets: [
            { name: "B", created_at: "2026-01-01T00:00:00Z" },
            { name: "A", created_at: "2026-01-01T00:00:00Z" },
          ],
        }),
    });
    const { kv, putSpy, store } = makeKv();
    const env = makeEnv(kv);

    const result = await gatherInventory(env, { commitSnapshot: true });
    expect(result.snapshot_committed).toBe(true);
    expect(result.snapshot_at).toBeTruthy();
    expect(putSpy).toHaveBeenCalledTimes(1);
    const written = JSON.parse(store.get(SNAPSHOT_KEY)!);
    expect(written.v).toBe(1);
    expect(written.names).toEqual(["A", "B"]); // sorted on write
    expect(typeof written.captured_at).toBe("string");
  });

  it("commitSnapshot:false leaves KV alone", async () => {
    installFetchMock({
      gcp: () =>
        Response.json({
          secrets: [{ name: "A", created_at: "2026-01-01T00:00:00Z" }],
        }),
    });
    const { kv, putSpy } = makeKv();
    const result = await gatherInventory(makeEnv(kv));
    expect(result.snapshot_committed).toBe(false);
    expect(putSpy).not.toHaveBeenCalled();
  });
});

describe("gatherInventory — service tokens (Refs #62)", () => {
  it("reconciles CF service tokens against GCP cf_token_id labels", async () => {
    installFetchMock({
      gcp: () =>
        Response.json({
          secrets: [
            {
              name: "testone-client-secret",
              created_at: "2026-01-01T00:00:00Z",
              labels: { cf_token_id: "st-ok" },
            },
            {
              name: "ghost-secret",
              created_at: "2026-01-01T00:00:00Z",
              labels: { cf_token_id: "st-gone" },
            },
          ],
        }),
      serviceTokens: () =>
        Response.json({
          service_tokens: [
            { id: "st-ok", name: "testone", client_id: "abc.access" },
            { id: "st-wild", name: "wild" },
          ],
        }),
    });
    const result = await gatherInventory(makeEnv(makeKv().kv));

    expect(result.provider_counts.service_tokens).toBe(2);
    expect(result.errors.service_tokens).toBeUndefined();

    const rows = result.service_tokens.rows;
    const statuses = rows.map((r) => r.status).sort();
    expect(statuses).toEqual(["missing_in_cf", "ok", "orphan"]);

    const ok = rows.find((r) => r.status === "ok");
    expect(ok?.cf?.name).toBe("testone");
    expect(ok?.gcp?.name).toBe("testone-client-secret");

    const orphan = rows.find((r) => r.status === "orphan");
    expect(orphan?.cf?.name).toBe("wild");
    expect(orphan?.gcp).toBeNull();

    const missing = rows.find((r) => r.status === "missing_in_cf");
    expect(missing?.gcp?.name).toBe("ghost-secret");
    expect(missing?.cf).toBeNull();
  });

  it("service token fetch fail → errors.service_tokens + counts null + rows empty", async () => {
    installFetchMock({
      gcp: () =>
        Response.json({
          secrets: [
            { name: "x", labels: { cf_token_id: "st-1" } },
          ],
        }),
      serviceTokens: () => new Response("forbidden", { status: 403 }),
    });
    const result = await gatherInventory(makeEnv(makeKv().kv));

    expect(result.errors.service_tokens).toMatch(/403/);
    expect(result.provider_counts.service_tokens).toBeNull();
    // 突合不能 = 誤検出しない (missing_in_cf を出さない)
    expect(result.service_tokens.rows).toEqual([]);
  });

  it("does not affect secret rows / errors when service tokens are empty", async () => {
    installFetchMock({
      gcp: () => Response.json({ secrets: [{ name: "A" }] }),
    });
    const result = await gatherInventory(makeEnv(makeKv().kv));
    expect(result.rows.map((r) => r.name)).toEqual(["A"]);
    expect(result.errors).toEqual({});
    expect(result.provider_counts.service_tokens).toBe(0);
    expect(result.service_tokens.rows).toEqual([]);
  });
});
