import { describe, it, expect } from "vitest";
import { createCloudflare } from "../../src/providers/cloudflare";
import { makeTestEnv } from "../helpers/env";
import { stubFetcher } from "../helpers/fetcher";

describe("createCloudflare", () => {
  it("list → POST when not exists, returns created=true + secret_id", async () => {
    const env = makeTestEnv();
    const { fetcher, calls } = stubFetcher([
      {
        method: "GET",
        match: "/secrets_store/stores/",
        body: { success: true, result: [{ id: "id-other", name: "OTHER" }] },
      },
      {
        method: "POST",
        match: "/secrets_store/stores/",
        body: { success: true, result: { id: "new-id", name: "NEW" } },
      },
    ]);
    const r = await createCloudflare(
      { name: "NEW", initialValue: "v" },
      { env, fetcher },
    );
    expect(r.status).toBe("ok");
    expect(r.created).toBe(true);
    expect(r.secret_id).toBe("new-id");

    const postCall = calls.find((c) => c.method === "POST")!;
    const body = JSON.parse(postCall.body!);
    expect(body.name).toBe("NEW");
    expect(body.value).toBe("v");
    expect(body.scopes).toEqual(["workers"]);
  });

  it("respects scopes override", async () => {
    const env = makeTestEnv();
    const { fetcher, calls } = stubFetcher([
      { method: "GET", match: "/secrets_store/stores/", body: { success: true, result: [] } },
      {
        method: "POST",
        match: "/secrets_store/stores/",
        body: { success: true, result: { id: "id1", name: "X" } },
      },
    ]);
    await createCloudflare(
      { name: "X", initialValue: "v", scopes: ["workers", "pages"] },
      { env, fetcher },
    );
    const postBody = JSON.parse(calls.find((c) => c.method === "POST")!.body!);
    expect(postBody.scopes).toEqual(["workers", "pages"]);
  });

  it("returns fail with 'already exists' when failIfExists=true (default)", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      {
        method: "GET",
        match: "/secrets_store/stores/",
        body: { success: true, result: [{ id: "existing-id", name: "DUP" }] },
      },
    ]);
    const r = await createCloudflare(
      { name: "DUP", initialValue: "v" },
      { env, fetcher },
    );
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/already exists/);
  });

  it("PATCH existing when failIfExists=false, returns created=false", async () => {
    const env = makeTestEnv();
    const { fetcher, calls } = stubFetcher([
      {
        method: "GET",
        match: "/secrets_store/stores/",
        body: { success: true, result: [{ id: "existing-id", name: "DUP" }] },
      },
      {
        method: "PATCH",
        match: "/secrets_store/stores/",
        body: { success: true, result: {} },
      },
    ]);
    const r = await createCloudflare(
      { name: "DUP", initialValue: "v", failIfExists: false },
      { env, fetcher },
    );
    expect(r.status).toBe("ok");
    expect(r.created).toBe(false);
    expect(r.secret_id).toBe("existing-id");
    expect(calls.find((c) => c.method === "POST")).toBeUndefined();
    expect(calls.find((c) => c.method === "PATCH")).toBeDefined();
  });

  it("accepts result as 1-element array (CF API variant)", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      { method: "GET", match: "/secrets_store/stores/", body: { success: true, result: [] } },
      {
        method: "POST",
        match: "/secrets_store/stores/",
        body: { success: true, result: [{ id: "arr-id", name: "X" }] },
      },
    ]);
    const r = await createCloudflare({ name: "X", initialValue: "v" }, { env, fetcher });
    expect(r.status).toBe("ok");
    expect(r.secret_id).toBe("arr-id");
  });

  it("returns fail on POST non-2xx", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      { method: "GET", match: "/secrets_store/stores/", body: { success: true, result: [] } },
      { method: "POST", match: "/secrets_store/stores/", body: "quota", status: 403 },
    ]);
    const r = await createCloudflare({ name: "X", initialValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/cf post 403/);
  });

  it("returns fail on POST envelope success=false", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      { method: "GET", match: "/secrets_store/stores/", body: { success: true, result: [] } },
      {
        method: "POST",
        match: "/secrets_store/stores/",
        body: { success: false, result: null, errors: [{ code: 9, message: "bad" }] },
      },
    ]);
    const r = await createCloudflare({ name: "X", initialValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/cf post error/);
  });

  it("returns fail on POST network error", async () => {
    const env = makeTestEnv();
    let first = true;
    const fetcher: typeof fetch = async () => {
      if (first) {
        first = false;
        return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
      }
      throw new Error("connection lost");
    };
    const r = await createCloudflare({ name: "X", initialValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/cf post network error/);
  });

  it("returns fail on POST bad json", async () => {
    const env = makeTestEnv();
    let first = true;
    const fetcher: typeof fetch = async () => {
      if (first) {
        first = false;
        return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
      }
      return new Response("not-json", { status: 200 });
    };
    const r = await createCloudflare({ name: "X", initialValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/cf post bad json/);
  });

  it("returns fail when POST response result has no id", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      { method: "GET", match: "/secrets_store/stores/", body: { success: true, result: [] } },
      { method: "POST", match: "/secrets_store/stores/", body: { success: true, result: {} } },
    ]);
    const r = await createCloudflare({ name: "X", initialValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/no id/);
  });

  it("returns fail on PATCH (failIfExists=false reuse) error", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      {
        method: "GET",
        match: "/secrets_store/stores/",
        body: { success: true, result: [{ id: "exist", name: "X" }] },
      },
      { method: "PATCH", match: "/secrets_store/stores/", body: "forbidden", status: 403 },
    ]);
    const r = await createCloudflare(
      { name: "X", initialValue: "v", failIfExists: false },
      { env, fetcher },
    );
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/cf patch 403/);
  });

  it("returns fail on PATCH network error (reuse path)", async () => {
    const env = makeTestEnv();
    let first = true;
    const fetcher: typeof fetch = async () => {
      if (first) {
        first = false;
        return new Response(
          JSON.stringify({ success: true, result: [{ id: "exist", name: "X" }] }),
          { status: 200 },
        );
      }
      throw new Error("net err");
    };
    const r = await createCloudflare(
      { name: "X", initialValue: "v", failIfExists: false },
      { env, fetcher },
    );
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/cf patch network error/);
  });

  it("returns fail on list errors (shared path)", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      { method: "GET", match: "/secrets_store/stores/", body: "boom", status: 500 },
    ]);
    const r = await createCloudflare({ name: "X", initialValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/cf list 500/);
  });
});
