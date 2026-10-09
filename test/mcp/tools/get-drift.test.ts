import { describe, expect, it, vi, afterEach } from "vitest";
import { getDriftInputSchema, getDriftTool } from "../../../src/mcp/tools/get-drift";
import { baseTestEnv } from "../../test-helpers";
import type { Env } from "../../../src/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function envWithKv(): Env {
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
  } as unknown as KVNamespace;
  return baseTestEnv({ SNAPSHOT_KV: kv }) as Env;
}

describe("get_drift input schema", () => {
  it("accepts empty object (defaults to all targets at execute time)", () => {
    const parsed = getDriftInputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it("accepts targets = ['github']", () => {
    const parsed = getDriftInputSchema.safeParse({ targets: ["github"] });
    expect(parsed.success).toBe(true);
  });

  it("accepts targets = ['service_tokens']", () => {
    const parsed = getDriftInputSchema.safeParse({
      targets: ["service_tokens"],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown target value", () => {
    const parsed = getDriftInputSchema.safeParse({ targets: ["bogus"] });
    expect(parsed.success).toBe(false);
  });

  it("rejects empty targets array (min(1))", () => {
    const parsed = getDriftInputSchema.safeParse({ targets: [] });
    expect(parsed.success).toBe(false);
  });

  it("rejects extra fields (strict object)", () => {
    const parsed = getDriftInputSchema.safeParse({
      targets: ["github"],
      foo: 1,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("get_drift execute — service_tokens target", () => {
  function installFetchMock(handlers: {
    gcp?: () => Response;
    serviceTokens?: () => Response;
  }) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/list-secrets")) {
        return handlers.gcp ? handlers.gcp() : Response.json({ secrets: [] });
      }
      if (url.includes("/cf/service-tokens")) {
        return handlers.serviceTokens
          ? handlers.serviceTokens()
          : Response.json({ service_tokens: [] });
      }
      if (url.includes("/gh/secrets")) return Response.json({ secrets: [] });
      if (url.includes("/cf/secrets")) return Response.json({ secrets: [] });
      return new Response("unexpected: " + url, { status: 500 });
    });
  }

  it("returns only drifted service token rows (orphan / missing), excludes ok", async () => {
    installFetchMock({
      gcp: () =>
        Response.json({
          secrets: [
            { name: "matched-secret", labels: { cf_token_id: "st-ok" } },
            { name: "ghost", labels: { cf_token_id: "st-gone" } },
          ],
        }),
      serviceTokens: () =>
        Response.json({
          service_tokens: [
            { id: "st-ok", name: "matched" },
            { id: "st-wild", name: "wild" },
          ],
        }),
    });

    const res = await getDriftTool.execute(envWithKv(), {
      targets: ["service_tokens"],
    });
    const statuses = res.service_token_rows.map((r) => r.status).sort();
    expect(statuses).toEqual(["missing_in_cf", "orphan"]);
    // ok 行は含まれない
    expect(res.service_token_rows.some((r) => r.status === "ok")).toBe(false);
    // service_tokens のみ指定なので GCP-centric rows は空
    expect(res.rows).toEqual([]);
  });

  it("omits service_token_rows when target not selected", async () => {
    installFetchMock({
      gcp: () =>
        Response.json({
          secrets: [{ name: "ghost", labels: { cf_token_id: "st-gone" } }],
        }),
      serviceTokens: () => Response.json({ service_tokens: [] }),
    });

    const res = await getDriftTool.execute(envWithKv(), {
      targets: ["github"],
    });
    expect(res.service_token_rows).toEqual([]);
  });
});

describe("get_drift name_filter", () => {
  it("schema accepts name_filter and rejects empty string", () => {
    expect(getDriftInputSchema.safeParse({ name_filter: "x" }).success).toBe(true);
    expect(getDriftInputSchema.safeParse({ name_filter: "" }).success).toBe(false);
  });

  it("filters drift rows and service_token_rows by name, echoes name_filter", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/list-secrets")) {
        return Response.json({
          secrets: [
            { name: "Alpha-One" },
            { name: "beta-two" },
            { name: "ledger-x", labels: { cf_token_id: "st-gone" } },
          ],
        });
      }
      if (url.includes("/cf/service-tokens")) {
        return Response.json({
          service_tokens: [{ id: "st-wild", name: "wild-token" }],
        });
      }
      if (url.includes("/gh/secrets")) return Response.json({ secrets: [] });
      if (url.includes("/cf/secrets")) return Response.json({ secrets: [] });
      return new Response("unexpected: " + url, { status: 500 });
    });

    const res = await getDriftTool.execute(envWithKv(), { name_filter: "ALPHA" });
    expect(res.rows.map((r) => r.name)).toEqual(["Alpha-One"]);
    expect(res.service_token_rows).toEqual([]);
    expect(res.name_filter).toBe("ALPHA");

    const tok = await getDriftTool.execute(envWithKv(), {
      targets: ["service_tokens"],
      name_filter: "wild",
    });
    expect(tok.service_token_rows.map((r) => r.cf_token_id)).toEqual(["st-wild"]);

    const none = await getDriftTool.execute(envWithKv(), {});
    expect("name_filter" in none).toBe(false);
  });
});
