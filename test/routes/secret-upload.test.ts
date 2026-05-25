import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { secretUploadRoutes } from "../../src/routes/secret-upload";
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

// secretUploadRoutes は本来 `/mcp/*` 配下に mount されて bindingJwtMiddleware
// が走るが、unit test では middleware を bypass して claims を直接 set する
// 軽量 app を組む。middleware 自体は別途 `test/middleware/binding-jwt.test.ts`
// 系で網羅される想定。
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
  app.route("/", secretUploadRoutes);
  return app;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("PUT /mcp/secret-upload/:name — auth + validation", () => {
  it("returns 403 when scope lacks mcp.write", async () => {
    const app = buildApp(readOnlyClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/secret-upload/FOO", {
        method: "PUT",
        body: "v",
      }),
      env(),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/mcp\.write/);
  });

  it("returns 400 on invalid secret name (lowercase start)", async () => {
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/secret-upload/9bad", {
        method: "PUT",
        body: "v",
      }),
      env(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on empty body (value is required)", async () => {
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/secret-upload/FOO", {
        method: "PUT",
        body: "",
      }),
      env(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/value is required/);
  });

  it("returns 413 when Content-Length exceeds 64KB cap", async () => {
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/secret-upload/FOO", {
        method: "PUT",
        body: "x",
        headers: { "Content-Length": "70000" },
      }),
      env(),
    );
    expect(res.status).toBe(413);
  });

  it("returns 400 on invalid mode query param", async () => {
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/secret-upload/FOO?mode=delete", {
        method: "PUT",
        body: "v",
      }),
      env(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid target in targets list", async () => {
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/secret-upload/FOO?targets=gcp,bogus", {
        method: "PUT",
        body: "v",
      }),
      env(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid fail_if_exists", async () => {
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request(
        "https://x.invalid/mcp/secret-upload/FOO?fail_if_exists=maybe",
        { method: "PUT", body: "v" },
      ),
      env(),
    );
    expect(res.status).toBe(400);
  });
});

describe("PUT /mcp/secret-upload/:name — create mode", () => {
  it("invokes the 3 provider proxies with body value (default targets)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/create-secret")) {
          return Response.json({
            ok: true,
            name: "FOO",
            created: true,
            new_version: "projects/p/secrets/FOO/versions/1",
          });
        }
        if (url.endsWith("/cf/secrets")) {
          return Response.json({ ok: true, secret_id: "cf-1" });
        }
        if (url.includes("/gh/secrets/FOO")) {
          return Response.json({ ok: true });
        }
        return new Response("?", { status: 500 });
      });
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/secret-upload/FOO", {
        method: "PUT",
        body: "secret-bytes-1234",
      }),
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      results: Record<string, { status: string } | undefined>;
    };
    expect(body.ok).toBe(true);
    expect(body.results.gcp?.status).toBe("ok");
    expect(body.results.cf?.status).toBe("ok");
    expect(body.results.github?.status).toBe("ok");

    // value が response body に echo されていない
    expect(JSON.stringify(body)).not.toContain("secret-bytes-1234");

    // 各 upstream の body に value が乗っていることを確認 (LLM context は
    // 経由しないが proxy には届く)
    let found = false;
    for (const [, init] of fetchSpy.mock.calls) {
      const b = (init as RequestInit | undefined)?.body;
      if (typeof b === "string" && b.includes("secret-bytes-1234")) found = true;
    }
    expect(found).toBe(true);
  });

  it("honors targets=github only", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/gh/secrets/FOO")) {
          return Response.json({ ok: true });
        }
        return new Response("unexpected: " + url, { status: 500 });
      });
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/secret-upload/FOO?targets=github", {
        method: "PUT",
        body: "v",
      }),
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      results: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.results.github).toBeDefined();
    expect(body.results.gcp).toBeUndefined();
    expect(body.results.cf).toBeUndefined();

    // proxy 呼び出しが GitHub だけになっている
    const urls = fetchSpy.mock.calls.map(([u]) =>
      typeof u === "string" ? u : u.toString(),
    );
    expect(urls.some((u) => u.includes("/create-secret"))).toBe(false);
    expect(urls.some((u) => u.includes("/cf/secrets"))).toBe(false);
    expect(urls.some((u) => u.includes("/gh/secrets/FOO"))).toBe(true);
  });

  it("returns 502 when at least one provider fails (partial failure)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/gh/secrets/FOO")) {
        return new Response("gh down", { status: 502 });
      }
      return new Response("?", { status: 500 });
    });
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/secret-upload/FOO?targets=github", {
        method: "PUT",
        body: "v",
      }),
      env(),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});

describe("PUT /mcp/secret-upload/:name — rotate mode", () => {
  it("calls add-version + cf rotate + gh PUT with body value", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/add-version")) {
          return Response.json({
            ok: true,
            new_version: "projects/p/secrets/FOO/versions/2",
          });
        }
        if (url.endsWith("/cf/secrets")) {
          return Response.json({ secrets: [{ id: "cf-1", name: "FOO" }] });
        }
        if (url.includes("/cf/secrets/cf-1")) {
          return Response.json({ ok: true, secret_id: "cf-1" });
        }
        if (url.includes("/gh/secrets/FOO")) {
          return Response.json({ ok: true });
        }
        return new Response("?", { status: 500 });
      });
    const app = buildApp(writeClaims);
    const res = await app.fetch(
      new Request("https://x.invalid/mcp/secret-upload/FOO?mode=rotate", {
        method: "PUT",
        body: "rotated-bytes-5678",
      }),
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      results: Record<string, { status: string } | undefined>;
    };
    expect(body.ok).toBe(true);
    expect(body.results.gcp?.status).toBe("ok");
    expect(body.results.cf?.status).toBe("ok");
    expect(body.results.github?.status).toBe("ok");

    // rotation_id 採番 prefix が `rot_` (= rotate path) であること
    expect((body as unknown as { rotation_id: string }).rotation_id).toMatch(
      /^rot_/,
    );

    // proxy 呼び出しに /add-version が使われている (rotate path)
    const urls = fetchSpy.mock.calls.map(([u]) =>
      typeof u === "string" ? u : u.toString(),
    );
    expect(urls.some((u) => u.includes("/add-version"))).toBe(true);
    expect(urls.some((u) => u.includes("/create-secret"))).toBe(false);
  });
});
