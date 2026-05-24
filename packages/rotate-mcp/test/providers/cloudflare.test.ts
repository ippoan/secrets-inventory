import { describe, it, expect } from "vitest";
import { rotateCloudflare } from "../../src/providers/cloudflare";
import { makeTestEnv } from "../helpers/env";
import { stubFetcher } from "../helpers/fetcher";

describe("rotateCloudflare", () => {
  it("lists secrets, finds id by name, then PATCH with value", async () => {
    const env = makeTestEnv();
    const { fetcher, calls } = stubFetcher([
      {
        method: "GET",
        match: "/secrets_store/stores/",
        body: {
          success: true,
          result: [
            { id: "id-other", name: "OTHER_SECRET" },
            { id: "id-target", name: "MY_SECRET" },
          ],
        },
      },
      {
        method: "PATCH",
        match: "/secrets_store/stores/",
        body: { success: true, result: {} },
      },
    ]);
    const r = await rotateCloudflare(
      { name: "MY_SECRET", newValue: "secret-payload" },
      { env, fetcher },
    );
    expect(r.status).toBe("ok");
    expect(r.secret_id).toBe("id-target");

    expect(calls.length).toBe(2);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[1]!.method).toBe("PATCH");
    expect(calls[1]!.url).toContain("/secrets/id-target");
    // value は PATCH body にだけ載る
    expect(calls[1]!.body).toBe(JSON.stringify({ value: "secret-payload" }));
  });

  it("returns fail when secret name is not in the list", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      {
        method: "GET",
        match: "/secrets_store/stores/",
        body: {
          success: true,
          result: [{ id: "id-other", name: "OTHER" }],
        },
      },
    ]);
    const r = await rotateCloudflare(
      { name: "MISSING", newValue: "v" },
      { env, fetcher },
    );
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/not found/);
  });

  it("returns fail on list network error", async () => {
    const env = makeTestEnv();
    const fetcher: typeof fetch = async () => {
      throw new Error("DNS fail");
    };
    const r = await rotateCloudflare(
      { name: "X", newValue: "v" },
      { env, fetcher },
    );
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/cf list network error/);
  });

  it("returns fail on list non-2xx", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      { method: "GET", match: "/secrets_store/stores/", body: "boom", status: 500 },
    ]);
    const r = await rotateCloudflare({ name: "X", newValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/cf list 500/);
  });

  it("returns fail when list envelope has success=false", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      {
        method: "GET",
        match: "/secrets_store/stores/",
        body: { success: false, result: [], errors: [{ code: 10000, message: "auth fail" }] },
      },
    ]);
    const r = await rotateCloudflare({ name: "X", newValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/cf list error/);
    expect(r.error).toMatch(/10000/);
  });

  it("returns fail on PATCH non-2xx", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      {
        method: "GET",
        match: "/secrets_store/stores/",
        body: { success: true, result: [{ id: "id1", name: "X" }] },
      },
      {
        method: "PATCH",
        match: "/secrets_store/stores/",
        body: "forbidden",
        status: 403,
      },
    ]);
    const r = await rotateCloudflare({ name: "X", newValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/cf patch 403/);
  });

  it("returns fail on PATCH envelope success=false", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      {
        method: "GET",
        match: "/secrets_store/stores/",
        body: { success: true, result: [{ id: "id1", name: "X" }] },
      },
      {
        method: "PATCH",
        match: "/secrets_store/stores/",
        body: { success: false, result: {}, errors: [{ code: 9999, message: "quota" }] },
      },
    ]);
    const r = await rotateCloudflare({ name: "X", newValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/quota/);
  });

  it("returns ok when PATCH body is not JSON but status is 2xx (CF empty body tolerance)", async () => {
    const env = makeTestEnv();
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("/secrets_store/stores/")) {
        return new Response(
          JSON.stringify({ success: true, result: [{ id: "id1", name: "X" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // PATCH returns empty body / non-JSON
      return new Response("", { status: 200 });
    };
    const r = await rotateCloudflare({ name: "X", newValue: "v" }, { env, fetcher });
    expect(r.status).toBe("ok");
    expect(r.secret_id).toBe("id1");
  });

  it("returns fail when PATCH network throws", async () => {
    const env = makeTestEnv();
    let firstCall = true;
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      void init;
      if (firstCall) {
        firstCall = false;
        return new Response(
          JSON.stringify({ success: true, result: [{ id: "id1", name: "X" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      void url;
      throw new Error("connection reset");
    };
    const r = await rotateCloudflare({ name: "X", newValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/cf patch network error/);
  });

  it("returns fail when list response body is not JSON", async () => {
    const env = makeTestEnv();
    const fetcher: typeof fetch = async () =>
      new Response("not-json", { status: 200 });
    const r = await rotateCloudflare({ name: "X", newValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/cf list bad json/);
  });
});
