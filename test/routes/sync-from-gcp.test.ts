import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { syncFromGcpRoutes } from "../../src/routes/sync-from-gcp";
import type { Env } from "../../src/types";
import type { BindingJwtClaims } from "../../src/middleware/binding-jwt";
import { baseTestEnv } from "../test-helpers";

function makeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
  } as unknown as KVNamespace;
}

function env(): Env {
  return baseTestEnv({ SNAPSHOT_KV: makeKv() }) as Env;
}

const writeClaims: BindingJwtClaims = {
  sub: "user:42",
  github_login: "octocat",
  scope: "mcp.read mcp.write",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

const readOnlyClaims: BindingJwtClaims = {
  ...writeClaims,
  scope: "mcp.read",
};

function buildApp(claims: BindingJwtClaims | undefined) {
  const app = new Hono<{
    Bindings: Env;
    Variables: { bindingJwt: BindingJwtClaims };
  }>();
  if (claims) {
    app.use("*", async (c, next) => {
      c.set("bindingJwt", claims);
      await next();
    });
  }
  app.route("/", syncFromGcpRoutes);
  return app;
}

const happyProxyResponse = {
  ok: true,
  source: "HEALTH_OAUTH_JWT",
  results: {
    gh: {
      status: "ok",
      secret_name: "HEALTH_OAUTH_JWT",
      created: true,
    },
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /mcp/sync-from-gcp/:name — auth + validation", () => {
  it("returns 400 on invalid src name (digit start)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/sync-from-gcp/1abc?targets=gh", { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 403 when scope lacks mcp.write", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const app = buildApp(readOnlyClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/sync-from-gcp/MY_SECRET?targets=gh", { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 when targets query is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/sync-from-gcp/MY_SECRET", { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 when targets contains an unknown value", async () => {
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/sync-from-gcp/MY_SECRET?targets=xxx", { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when targets is only commas", async () => {
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/sync-from-gcp/MY_SECRET?targets=,,", { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid gh_name", async () => {
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request(
        "https://x.invalid/mcp/sync-from-gcp/MY_SECRET?targets=gh&gh_name=1bad",
        { method: "POST" },
      ),
      env(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid cf_name", async () => {
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request(
        "https://x.invalid/mcp/sync-from-gcp/MY_SECRET?targets=cf&cf_name=1bad",
        { method: "POST" },
      ),
      env(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid visibility", async () => {
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request(
        "https://x.invalid/mcp/sync-from-gcp/MY_SECRET?targets=gh&visibility=public",
        { method: "POST" },
      ),
      env(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid fail_if_exists", async () => {
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request(
        "https://x.invalid/mcp/sync-from-gcp/MY_SECRET?targets=gh&fail_if_exists=maybe",
        { method: "POST" },
      ),
      env(),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /mcp/sync-from-gcp/:name — happy path", () => {
  it("proxies to upstream with API key + actor + query params", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(happyProxyResponse),
    );

    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request(
        "https://x.invalid/mcp/sync-from-gcp/HEALTH_OAUTH_JWT?targets=gh&fail_if_exists=false",
        { method: "POST" },
      ),
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      source: string;
      results: Record<string, { status: string }>;
    };
    expect(body.status).toBe("ok");
    expect(body.source).toBe("HEALTH_OAUTH_JWT");
    expect(body.results.gh!.status).toBe("ok");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    const urlStr = typeof url === "string" ? url : (url as URL).toString();
    expect(urlStr).toContain("/sync-from-gcp/HEALTH_OAUTH_JWT");
    expect(urlStr).toContain("targets=gh");
    expect(urlStr).toContain("fail_if_exists=false");
    expect((init as RequestInit)?.method).toBe("POST");
    const headers = (init as RequestInit)?.headers as Record<string, string>;
    expect(headers["X-Inventory-API-Key"]).toBe("shared-secret");
    expect(headers["X-Actor-Email"]).toBe("octocat");
  });

  it("forwards gh_name / cf_name / visibility / scopes to upstream query", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: true, source: "x", results: {} }),
    );

    const app = buildApp(writeClaims);
    await app.fetch(
      new Request(
        "https://x.invalid/mcp/sync-from-gcp/MY_SECRET?targets=gh,cf" +
          "&gh_name=GH_NAME&cf_name=cf-name&visibility=private&scopes=workers,pages",
        { method: "POST" },
      ),
      env(),
    );
    const urlStr = String(fetchSpy.mock.calls[0]![0]);
    expect(urlStr).toContain("gh_name=GH_NAME");
    expect(urlStr).toContain("cf_name=cf-name");
    expect(urlStr).toContain("visibility=private");
    expect(urlStr).toContain("scopes=workers%2Cpages");
    // targets is URL-encoded when set via URLSearchParams (comma may stay or
    // be %2C depending on impl; assert via decoded form)
    expect(decodeURIComponent(urlStr)).toContain("targets=gh,cf");
  });

  it("dedupes duplicate targets", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: true, source: "x", results: {} }),
    );

    const app = buildApp(writeClaims);
    await app.fetch(
      new Request(
        "https://x.invalid/mcp/sync-from-gcp/MY_SECRET?targets=gh,gh,cf,cf",
        { method: "POST" },
      ),
      env(),
    );
    const urlStr = decodeURIComponent(String(fetchSpy.mock.calls[0]![0]));
    // After dedup it should be exactly "gh,cf" (in encounter order)
    expect(urlStr).toMatch(/targets=gh,cf(?:&|$)/);
  });

  it("treats fail_if_exists default as undefined (proxy decides)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: true, source: "x", results: {} }),
    );

    const app = buildApp(writeClaims);
    await app.fetch(
      new Request("https://x.invalid/mcp/sync-from-gcp/MY_SECRET?targets=gh", { method: "POST" }),
      env(),
    );
    const urlStr = String(fetchSpy.mock.calls[0]![0]);
    expect(urlStr).not.toContain("fail_if_exists=");
  });

  it("omits X-Actor-Email when binding_jwt has no github_login", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(happyProxyResponse),
    );

    const app = buildApp({
      sub: "user:42",
      scope: "mcp.write",
      exp: Math.floor(Date.now() / 1000) + 3600,
    } as BindingJwtClaims);
    await app.fetch(
      new Request("https://x.invalid/mcp/sync-from-gcp/MY_SECRET?targets=gh", { method: "POST" }),
      env(),
    );
    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Actor-Email"]).toBeUndefined();
  });
});

describe("POST /mcp/sync-from-gcp/:name — upstream failures", () => {
  it("returns 502 when proxy returns 5xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: false, error: "upstream permission denied" }, { status: 502 }),
    );

    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/sync-from-gcp/MY_SECRET?targets=gh", { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(502);
  });

  it("returns 502 when proxy returns ok:false with per-target failure detail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          ok: false,
          source: "HEALTH_OAUTH_JWT",
          results: { gh: { status: "fail", error: "gh secret already exists" } },
        },
        { status: 502 },
      ),
    );

    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/sync-from-gcp/HEALTH_OAUTH_JWT?targets=gh", { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      status: string;
      results: Record<string, { status: string; error: string }>;
    };
    expect(body.status).toBe("fail");
    expect(body.results.gh!.error).toMatch(/already exists/);
  });

  it("returns 502 on network/fetch error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("dns failure"));

    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/sync-from-gcp/MY_SECRET?targets=gh", { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/dns failure/);
  });

  it("returns 502 on non-JSON upstream body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>oops</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    );

    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/sync-from-gcp/MY_SECRET?targets=gh", { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/bad json/);
  });
});

describe("POST /mcp/sync-from-gcp/:name — gh_org (Refs ippoan/secrets-inventory-gcp#49)", () => {
  it("forwards gh_org to upstream query", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: true, source: "x", results: {} }),
    );

    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request(
        "https://x.invalid/mcp/sync-from-gcp/CI_APP_PRIVATE_KEY_PKCS8" +
          "?targets=gh&gh_org=ohishi-exp&gh_name=CI_APP_PRIVATE_KEY",
        { method: "POST" },
      ),
      env(),
    );
    expect(res.status).toBe(200);
    const urlStr = String(fetchSpy.mock.calls[0]![0]);
    expect(urlStr).toContain("gh_org=ohishi-exp");
  });

  it("returns 400 on invalid gh_org", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request(
        "https://x.invalid/mcp/sync-from-gcp/MY_SECRET?targets=gh&gh_org=-bad",
        { method: "POST" },
      ),
      env(),
    );
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 when gh_org is given without gh target", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request(
        "https://x.invalid/mcp/sync-from-gcp/MY_SECRET?targets=cf&gh_org=ohishi-exp",
        { method: "POST" },
      ),
      env(),
    );
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
