import { describe, it, expect } from "vitest";
import { createGcp } from "../../src/providers/gcp";
import { makeTestEnv } from "../helpers/env";
import { stubFetcher } from "../helpers/fetcher";

describe("createGcp", () => {
  it("POST /create-secret with X-Fail-If-Exists=true by default", async () => {
    const env = makeTestEnv();
    const { fetcher, calls } = stubFetcher([
      {
        method: "POST",
        match: "/create-secret",
        body: {
          ok: true,
          name: "NEW",
          created: true,
          new_version: "projects/p/secrets/NEW/versions/1",
        },
      },
    ]);
    const r = await createGcp(
      { name: "NEW", initialValue: "first-value" },
      { env, fetcher },
    );
    expect(r.status).toBe("ok");
    expect(r.created).toBe(true);
    expect(r.new_version).toBe("projects/p/secrets/NEW/versions/1");
    expect(calls[0]!.url).toContain("/create-secret?name=NEW");
    expect(calls[0]!.body).toBe(JSON.stringify({ value: "first-value" }));
  });

  it("returns fail with 'already exists' on 409", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      { method: "POST", match: "/create-secret", body: "conflict", status: 409 },
    ]);
    const r = await createGcp({ name: "EX", initialValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/already exists/);
  });

  it("forwards X-Fail-If-Exists=false header + returns created=false on reuse", async () => {
    const env = makeTestEnv();
    let seenHeader: string | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      seenHeader = headers["X-Fail-If-Exists"];
      return new Response(
        JSON.stringify({
          ok: true,
          name: "EX",
          created: false,
          new_version: "projects/p/secrets/EX/versions/5",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const r = await createGcp(
      { name: "EX", initialValue: "v", failIfExists: false },
      { env, fetcher },
    );
    expect(seenHeader).toBe("false");
    expect(r.status).toBe("ok");
    expect(r.created).toBe(false);
  });

  it("forwards X-Actor-Email", async () => {
    const env = makeTestEnv();
    let seenActor: string | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      seenActor = headers["X-Actor-Email"];
      return new Response(
        JSON.stringify({ ok: true, name: "N", created: true, new_version: "p/secrets/N/versions/1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    await createGcp(
      { name: "N", initialValue: "v", actorEmail: "actor@example.com" },
      { env, fetcher },
    );
    expect(seenActor).toBe("actor@example.com");
  });

  it("returns fail on network error", async () => {
    const env = makeTestEnv();
    const fetcher: typeof fetch = async () => {
      throw new Error("ECONNRESET");
    };
    const r = await createGcp({ name: "N", initialValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/network error/);
  });

  it("returns fail on non-2xx (non-409)", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      { method: "POST", match: "/create-secret", body: "perm denied", status: 502 },
    ]);
    const r = await createGcp({ name: "N", initialValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/gcp proxy 502/);
  });

  it("returns fail on bad json", async () => {
    const env = makeTestEnv();
    const fetcher: typeof fetch = async () =>
      new Response("not-json", { status: 200 });
    const r = await createGcp({ name: "N", initialValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/bad json/);
  });

  it("returns fail when proxy returns ok=false", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      { method: "POST", match: "/create-secret", body: { ok: false } },
    ]);
    const r = await createGcp({ name: "N", initialValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
  });
});
