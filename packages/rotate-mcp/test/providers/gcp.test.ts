import { describe, it, expect } from "vitest";
import { rotateGcp } from "../../src/providers/gcp";
import { makeTestEnv } from "../helpers/env";
import { stubFetcher } from "../helpers/fetcher";

describe("rotateGcp", () => {
  it("posts to /add-version with API key + value body, parses new_version", async () => {
    const env = makeTestEnv();
    const { fetcher, calls } = stubFetcher([
      {
        method: "POST",
        match: "/add-version",
        body: { ok: true, new_version: "projects/p/secrets/MY_SECRET/versions/7" },
      },
    ]);
    const r = await rotateGcp(
      { name: "MY_SECRET", newValue: "secret-payload" },
      { env, fetcher },
    );
    expect(r.status).toBe("ok");
    expect(r.new_version).toBe("projects/p/secrets/MY_SECRET/versions/7");

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("/add-version?name=MY_SECRET");
    expect(calls[0]!.method).toBe("POST");
    // value は JSON body にだけ載る
    expect(calls[0]!.body).toBe(JSON.stringify({ value: "secret-payload" }));
  });

  it("forwards X-Actor-Email and X-Expected-Version-Id headers", async () => {
    const env = makeTestEnv();
    let capturedHeaders: Record<string, string> = {};
    const fetcher: typeof fetch = async (input, init) => {
      const headers = init?.headers as Record<string, string>;
      capturedHeaders = headers;
      void input;
      return new Response(
        JSON.stringify({ ok: true, new_version: "projects/p/secrets/X/versions/1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    await rotateGcp(
      {
        name: "X",
        newValue: "v",
        expectedVersionId: "5",
        actorEmail: "actor@example.com",
      },
      { env, fetcher },
    );
    expect(capturedHeaders["X-Actor-Email"]).toBe("actor@example.com");
    expect(capturedHeaders["X-Expected-Version-Id"]).toBe("5");
  });

  it("returns fail status on network error (does not throw)", async () => {
    const env = makeTestEnv();
    const fetcher: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const r = await rotateGcp({ name: "X", newValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/network error/);
    expect(r.error).toMatch(/ECONNREFUSED/);
  });

  it("returns fail on non-2xx HTTP status (truncates upstream body)", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      {
        method: "POST",
        match: "/add-version",
        body: "x".repeat(500),
        status: 502,
      },
    ]);
    const r = await rotateGcp({ name: "X", newValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/^gcp proxy 502:/);
    // body は 200 chars でクランプされる (+ JSON.stringify の quote 等で多少
    // 増えるが、500 chars 全部が出てないこと)
    expect(r.error!.length).toBeLessThan(300);
  });

  it("returns fail when proxy returns ok=false", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      {
        method: "POST",
        match: "/add-version",
        body: { ok: false },
      },
    ]);
    const r = await rotateGcp({ name: "X", newValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
  });

  it("returns fail when proxy returns missing new_version", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      {
        method: "POST",
        match: "/add-version",
        body: { ok: true },
      },
    ]);
    const r = await rotateGcp({ name: "X", newValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
  });

  it("returns fail on non-JSON response", async () => {
    const env = makeTestEnv();
    const fetcher: typeof fetch = async () =>
      new Response("not-json-at-all", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    const r = await rotateGcp({ name: "X", newValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/bad json/);
  });
});
