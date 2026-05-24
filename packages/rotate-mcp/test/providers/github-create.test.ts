import { describe, it, expect } from "vitest";
import { createGithub } from "../../src/providers/github";
import { makeTestEnv } from "../helpers/env";
import { stubFetcher, TEST_GH_PUBLIC_KEY_B64 } from "../helpers/fetcher";

describe("createGithub", () => {
  it("GET 404 → PUT (encrypt) returns ok + created=true (failIfExists default)", async () => {
    const env = makeTestEnv();
    const { fetcher, calls } = stubFetcher([
      // GET pre-check: not found
      {
        method: "GET",
        match: "/actions/secrets/NEW_SECRET",
        body: { message: "not found" },
        status: 404,
      },
      // public-key fetch
      {
        method: "GET",
        match: "/actions/secrets/public-key",
        body: { key_id: "kid-1", key: TEST_GH_PUBLIC_KEY_B64 },
      },
      // PUT secret
      { method: "PUT", match: "/actions/secrets/", status: 201 },
    ]);
    const r = await createGithub(
      { name: "NEW_SECRET", initialValue: "secret-payload" },
      { env, fetcher },
    );
    expect(r.status).toBe("ok");
    expect(r.created).toBe(true);

    const putCall = calls.find((c) => c.method === "PUT")!;
    expect(putCall.body!).not.toContain("secret-payload");
  });

  it("GET 200 → fail with 'already exists' (failIfExists default)", async () => {
    const env = makeTestEnv();
    const { fetcher, calls } = stubFetcher([
      {
        method: "GET",
        match: "/actions/secrets/EXISTING",
        body: { name: "EXISTING", updated_at: "2026-01-01T00:00:00Z" },
        status: 200,
      },
    ]);
    const r = await createGithub(
      { name: "EXISTING", initialValue: "v" },
      { env, fetcher },
    );
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/already exists/);
    // PUT は呼ばれていない
    expect(calls.find((c) => c.method === "PUT")).toBeUndefined();
  });

  it("PUT directly (no GET) when failIfExists=false, returns created=false", async () => {
    const env = makeTestEnv();
    const { fetcher, calls } = stubFetcher([
      {
        method: "GET",
        match: "/actions/secrets/public-key",
        body: { key_id: "kid-1", key: TEST_GH_PUBLIC_KEY_B64 },
      },
      { method: "PUT", match: "/actions/secrets/", status: 204 },
    ]);
    const r = await createGithub(
      { name: "EX", initialValue: "v", failIfExists: false },
      { env, fetcher },
    );
    expect(r.status).toBe("ok");
    expect(r.created).toBe(false);
    // GET /actions/secrets/<name> (pre-check) は呼ばれない、public-key は呼ばれる
    const preCheck = calls.find(
      (c) => c.method === "GET" && c.url.endsWith("/actions/secrets/EX"),
    );
    expect(preCheck).toBeUndefined();
  });

  it("returns fail on GET pre-check network error (failIfExists=true)", async () => {
    const env = makeTestEnv();
    const fetcher: typeof fetch = async () => {
      throw new Error("DNS fail");
    };
    const r = await createGithub({ name: "X", initialValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/get network error/);
  });

  it("returns fail on GET pre-check non-200 non-404 (e.g. 401)", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      { method: "GET", match: "/actions/secrets/X", body: "unauth", status: 401 },
    ]);
    const r = await createGithub({ name: "X", initialValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/github get 401/);
  });

  it("propagates PUT failure from rotateGithub path", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      { method: "GET", match: "/actions/secrets/X", body: "nf", status: 404 },
      {
        method: "GET",
        match: "/actions/secrets/public-key",
        body: { key_id: "kid-1", key: TEST_GH_PUBLIC_KEY_B64 },
      },
      { method: "PUT", match: "/actions/secrets/", body: "bad name", status: 422 },
    ]);
    const r = await createGithub(
      { name: "X", initialValue: "v" },
      { env, fetcher },
    );
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/put 422/);
  });
});
