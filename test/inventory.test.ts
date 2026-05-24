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

function makeEnv(kv: KVNamespace): Env {
  return {
    CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CF_ACCESS_AUD: "aud",
    CF_ACCOUNT_ID: "acc",
    CF_STORE_ID: "store",
    CF_API_TOKEN: mockSecret("cf-tok"),
    GITHUB_ORG: "ippoan",
    GITHUB_PAT: mockSecret("gh-tok"),
    GCP_PROJECT_ID: "cloudsql-sv",
    GCP_PROXY_URL: "https://gcp-stub.run.app",
    GCP_PROXY_API_KEY: mockSecret("shared-secret"),
    SNAPSHOT_KV: kv,
    MCP_SERVER_NAME: "secrets-inventory-read-mcp",
    MCP_SERVER_VERSION: "0.0.1",
    MCP_PROTOCOL_VERSION: "2025-03-26",
    AUTH_WORKER_ORIGIN: "https://auth.invalid",
  };
}

/**
 * fetch mock: URL prefix で各 provider のレスポンスを切り替える。各 case
 * で書きやすいよう、設定 dict ベース。
 */
function installFetchMock(handlers: {
  gcp?: () => Response;
  github?: () => Response;
  cloudflare?: () => Response;
}) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("https://gcp-stub.run.app")) {
      return handlers.gcp
        ? handlers.gcp()
        : Response.json({ secrets: [] });
    }
    if (url.startsWith("https://api.github.com")) {
      return handlers.github
        ? handlers.github()
        : Response.json({ total_count: 0, secrets: [] });
    }
    if (url.startsWith("https://api.cloudflare.com")) {
      return handlers.cloudflare
        ? handlers.cloudflare()
        : Response.json({ success: true, result: [] });
    }
    return new Response("unexpected", { status: 500 });
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
          total_count: 1,
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
          success: true,
          result: [{ id: "id-b", name: "B" }],
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
  // hasn't been provisioned in the store. Each provider's token fetch +
  // list call は 1 つの promise にまとめてあるので、ここで throw しても
  // その provider だけが reject して全体は止まらない。
  function throwingSecret(reason: string): SecretsStoreSecret {
    return {
      get: async () => {
        throw new Error(reason);
      },
    } as unknown as SecretsStoreSecret;
  }

  it("CF token .get() throws → in_cloudflare=null + errors.cloudflare (not 500)", async () => {
    installFetchMock({
      gcp: () =>
        Response.json({
          secrets: [{ name: "A", created_at: "2026-01-01T00:00:00Z" }],
        }),
    });
    const env = makeEnv(makeKv().kv);
    env.CF_API_TOKEN = throwingSecret("Secrets Worker: Failed to fetch secret");
    const result = await gatherInventory(env);
    expect(result.rows[0]?.in_cloudflare).toBeNull();
    expect(result.errors.cloudflare).toMatch(/Secrets Worker/);
    // GitHub の方は無事だったので errors.github は出ない
    expect(result.errors.github).toBeUndefined();
  });

  it("GitHub token .get() throws → in_github=null + errors.github (not 500)", async () => {
    installFetchMock({
      gcp: () =>
        Response.json({
          secrets: [{ name: "A", created_at: "2026-01-01T00:00:00Z" }],
        }),
    });
    const env = makeEnv(makeKv().kv);
    env.GITHUB_PAT = throwingSecret("Secrets Worker: Failed to fetch secret");
    const result = await gatherInventory(env);
    expect(result.rows[0]?.in_github).toBeNull();
    expect(result.errors.github).toMatch(/Secrets Worker/);
  });

  it("GCP token .get() throws → GcpUnavailableError (source of truth)", async () => {
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
