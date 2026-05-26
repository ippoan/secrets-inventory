import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mintHealthOAuthJwtRoutes } from "../../src/routes/mint-health-oauth-jwt";
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
  app.route("/", mintHealthOAuthJwtRoutes);
  return app;
}

const happyProxyResponse = {
  ok: true,
  secret_name: "HEALTH_OAUTH_JWT",
  new_version: "projects/p/secrets/HEALTH_OAUTH_JWT/versions/3",
  created: false,
  expires_at: "2027-05-26T12:00:00Z",
};

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /mcp/mint-health-oauth-jwt — auth", () => {
  it("returns 403 when scope lacks mcp.write", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const app = buildApp(readOnlyClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/mint-health-oauth-jwt", { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/mcp\.write/);
    // Must not have called the upstream proxy when scope check fails.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 403 when binding_jwt has empty scope string", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const app = buildApp({ ...writeClaims, scope: "" });
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/mint-health-oauth-jwt", { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 403 when scope claim is missing entirely", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // Cover the `(claims?.scope ?? "")` fallback by omitting scope.
    const app = buildApp({
      sub: "user:42",
      github_login: "octocat",
      exp: Math.floor(Date.now() / 1000) + 3600,
    } as BindingJwtClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/mint-health-oauth-jwt", { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("POST /mcp/mint-health-oauth-jwt — happy path", () => {
  it("proxies POST to upstream with API key + actor email header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(happyProxyResponse),
    );

    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/mint-health-oauth-jwt", { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      secret_name: string;
      new_version: string;
      created: boolean;
      expires_at: string;
    };
    expect(body.status).toBe("ok");
    expect(body.secret_name).toBe("HEALTH_OAUTH_JWT");
    expect(body.new_version).toBe(happyProxyResponse.new_version);
    expect(body.created).toBe(false);
    expect(body.expires_at).toBe("2027-05-26T12:00:00Z");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(typeof url === "string" ? url : url.toString()).toBe(
      "https://gcp-stub.run.app/mint-health-oauth-jwt",
    );
    expect((init as RequestInit)?.method).toBe("POST");
    const headers = (init as RequestInit)?.headers as Record<string, string>;
    expect(headers["X-Inventory-API-Key"]).toBe("shared-secret");
    expect(headers["X-Actor-Email"]).toBe("octocat");
  });

  it("forwards `created: true` when upstream reports first-time mint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ...happyProxyResponse, created: true }),
    );

    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/mint-health-oauth-jwt", { method: "POST" }),
      env(),
    );
    const body = (await res.json()) as { created: boolean };
    expect(body.created).toBe(true);
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
      new Request("https://x.invalid/mcp/mint-health-oauth-jwt", { method: "POST" }),
      env(),
    );
    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Actor-Email"]).toBeUndefined();
  });
});

describe("POST /mcp/mint-health-oauth-jwt — upstream failures", () => {
  it("returns 502 when upstream proxy returns non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream permission denied", { status: 502 }),
    );

    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/mint-health-oauth-jwt", { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { status: string; error: string };
    expect(body.status).toBe("fail");
    expect(body.error).toMatch(/gcp proxy 502/);
  });

  it("returns 502 when upstream responds with ok:false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: false, new_version: "x" }),
    );

    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/mint-health-oauth-jwt", { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { status: string; error: string };
    expect(body.error).toMatch(/ok=false/);
  });

  it("returns 502 when upstream omits new_version", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: true, secret_name: "HEALTH_OAUTH_JWT" }),
    );

    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/mint-health-oauth-jwt", { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(502);
  });

  it("returns 502 on network/fetch error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("conn reset"));

    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/mint-health-oauth-jwt", { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/network.*conn reset/);
  });

  it("returns 502 on non-Error fetch rejection", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue("string thrown");

    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/mint-health-oauth-jwt", { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("string thrown");
  });

  it("returns 502 when upstream body is non-JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>oops</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/mint-health-oauth-jwt", { method: "POST" }),
      env(),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/bad json/);
  });
});
