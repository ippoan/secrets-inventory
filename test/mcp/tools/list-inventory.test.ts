import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listInventoryInputSchema,
  listInventoryTool,
} from "../../../src/mcp/tools/list-inventory";
import { SNAPSHOT_KEY } from "../../../src/snapshot";
import { baseTestEnv } from "../../test-helpers";
import type { Env } from "../../../src/types";

describe("list_inventory input schema", () => {
  it("accepts empty object", () => {
    expect(listInventoryInputSchema.safeParse({}).success).toBe(true);
  });

  it("accepts commit_snapshot=true", () => {
    expect(
      listInventoryInputSchema.safeParse({ commit_snapshot: true }).success,
    ).toBe(true);
  });

  it("accepts commit_snapshot=false", () => {
    expect(
      listInventoryInputSchema.safeParse({ commit_snapshot: false }).success,
    ).toBe(true);
  });

  it("rejects commit_snapshot as string", () => {
    expect(
      listInventoryInputSchema.safeParse({ commit_snapshot: "yes" }).success,
    ).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      listInventoryInputSchema.safeParse({ extra: 1 }).success,
    ).toBe(false);
  });
});

describe("list_inventory name_filter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeEnv(): { env: Env; store: Map<string, string> } {
    const store = new Map<string, string>();
    const kv = {
      get: async (k: string) => {
        const v = store.get(k);
        return v === undefined ? null : JSON.parse(v);
      },
      put: async (k: string, v: string) => void store.set(k, v),
    } as unknown as KVNamespace;
    return { env: baseTestEnv({ SNAPSHOT_KV: kv }) as Env, store };
  }

  function installFetchMock() {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/list-secrets")) {
        return Response.json({
          secrets: [
            { name: "alpha-db-url" },
            { name: "Beta_API_KEY" },
            { name: "gamma-token", labels: { cf_token_id: "st-1" } },
            { name: "delta-ledger", labels: { cf_token_id: "st-gone" } },
          ],
        });
      }
      if (url.includes("/cf/service-tokens")) {
        return Response.json({
          service_tokens: [
            { id: "st-1", name: "svc-one" },
            { id: "st-wild", name: "wild-two" },
          ],
        });
      }
      if (url.includes("/gh/secrets")) return Response.json({ secrets: [] });
      if (url.includes("/cf/secrets")) return Response.json({ secrets: [] });
      return new Response("unexpected: " + url, { status: 500 });
    });
  }

  it("schema: accepts name_filter, rejects empty / too long / non-string", () => {
    expect(
      listInventoryInputSchema.safeParse({ name_filter: "abc" }).success,
    ).toBe(true);
    expect(
      listInventoryInputSchema.safeParse({ name_filter: "" }).success,
    ).toBe(false);
    expect(
      listInventoryInputSchema.safeParse({ name_filter: "a".repeat(129) })
        .success,
    ).toBe(false);
    expect(
      listInventoryInputSchema.safeParse({ name_filter: 1 }).success,
    ).toBe(false);
  });

  it("returns only matching rows and echoes unfiltered counts", async () => {
    installFetchMock();
    const { env, store } = makeEnv();
    store.set(
      SNAPSHOT_KEY,
      JSON.stringify({
        v: 1,
        captured_at: "2026-05-20T00:00:00Z",
        names: ["Beta_API_KEY", "old-gone-alpha"],
      }),
    );
    const res = await listInventoryTool.execute(env, { name_filter: "alpha" });
    expect(res.rows.map((r) => r.name)).toEqual(["alpha-db-url"]);
    expect(res.name_filter).toBe("alpha");
    expect(res.unfiltered_counts?.rows).toBe(4);
    // provider_counts は生件数のまま
    expect(res.provider_counts.gcp).toBe(4);
    expect(res.diff.added).toEqual(["alpha-db-url"]);
    expect(res.diff.removed).toEqual(["old-gone-alpha"]);
    expect(res.unfiltered_counts?.diff_added).toBe(3);
  });

  it("returns empty rows when nothing matches", async () => {
    installFetchMock();
    const { env } = makeEnv();
    const res = await listInventoryTool.execute(env, { name_filter: "zzz" });
    expect(res.rows).toEqual([]);
    expect(res.service_tokens.rows).toEqual([]);
  });

  it("is case-insensitive", async () => {
    installFetchMock();
    const { env } = makeEnv();
    const res = await listInventoryTool.execute(env, { name_filter: "BETA_api" });
    expect(res.rows.map((r) => r.name)).toEqual(["Beta_API_KEY"]);
  });

  it("filters service_tokens.rows by token name or SM secret name", async () => {
    installFetchMock();
    const { env } = makeEnv();
    const byToken = await listInventoryTool.execute(env, { name_filter: "wild" });
    expect(byToken.service_tokens.rows.map((r) => r.cf_token_id)).toEqual([
      "st-wild",
    ]);
    const bySm = await listInventoryTool.execute(env, { name_filter: "ledger" });
    expect(bySm.service_tokens.rows.map((r) => r.cf_token_id)).toEqual([
      "st-gone",
    ]);
    // ok 行 (cf = svc-one / gcp = gamma-token) はどちらの名前でも拾える
    const byCf = await listInventoryTool.execute(env, { name_filter: "svc-one" });
    expect(byCf.service_tokens.rows.map((r) => r.status)).toEqual(["ok"]);
    const byGcp = await listInventoryTool.execute(env, { name_filter: "gamma" });
    expect(byGcp.service_tokens.rows.map((r) => r.status)).toEqual(["ok"]);
  });

  it("commit_snapshot with name_filter writes the full unfiltered GCP name list", async () => {
    installFetchMock();
    const { env, store } = makeEnv();
    const res = await listInventoryTool.execute(env, {
      name_filter: "alpha",
      commit_snapshot: true,
    });
    expect(res.rows).toHaveLength(1);
    expect(res.snapshot_committed).toBe(true);
    const saved = JSON.parse([...store.values()][0]!) as { names: string[] };
    expect([...saved.names].sort()).toEqual([
      "Beta_API_KEY",
      "alpha-db-url",
      "delta-ledger",
      "gamma-token",
    ]);
  });

  it("without name_filter the response has no filter fields", async () => {
    installFetchMock();
    const { env } = makeEnv();
    const res = await listInventoryTool.execute(env, {});
    expect(res.rows).toHaveLength(4);
    expect("name_filter" in res).toBe(false);
    expect("unfiltered_counts" in res).toBe(false);
  });
});
