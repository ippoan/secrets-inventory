import { describe, it, expect } from "vitest";
import { executeRotateSecret } from "../../../src/mcp/tools/rotate-secret";
import { makeTestEnv } from "../../helpers/env";
import { stubFetcher, happyPathRoutes, TEST_GH_PUBLIC_KEY_B64 } from "../../helpers/fetcher";

const baseArgs = {
  name: "MY_SECRET",
  new_value: "super-secret-value",
  confirm_name: "MY_SECRET",
  targets: ["gcp", "cf", "github"] as const,
};

describe("executeRotateSecret (Phase B real executor)", () => {
  it("3 providers all ok → ok=true + rotation_id + all results", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher(happyPathRoutes("MY_SECRET"));
    const r = await executeRotateSecret(
      { ...baseArgs, targets: [...baseArgs.targets] },
      env,
      { fetcher },
    );
    expect(r.ok).toBe(true);
    expect(r.dry_run).toBe(false);
    expect(r.rotation_id).toMatch(/^rot_/);
    expect(r.results.gcp?.status).toBe("ok");
    expect(r.results.cf?.status).toBe("ok");
    expect(r.results.github?.status).toBe("ok");
  });

  it("partial failure: github fails → ok=false but other providers still succeeded", async () => {
    const env = makeTestEnv();
    const routes = happyPathRoutes("MY_SECRET");
    // GitHub PUT を 403 に差し替え
    const ghPutIdx = routes.findIndex((r) => r.method === "PUT" && r.match.includes("/actions/secrets/"));
    routes[ghPutIdx] = { method: "PUT", match: "/actions/secrets/", body: "forbidden", status: 403 };
    const { fetcher } = stubFetcher(routes);

    const r = await executeRotateSecret(
      { ...baseArgs, targets: [...baseArgs.targets] },
      env,
      { fetcher },
    );
    expect(r.ok).toBe(false);
    // partial: gcp + cf は ok のまま (= rollback しない)
    expect(r.results.gcp?.status).toBe("ok");
    expect(r.results.cf?.status).toBe("ok");
    expect(r.results.github?.status).toBe("fail");
  });

  it("runs providers in parallel (CF list + GCP add-version + GitHub public-key 同時)", async () => {
    const env = makeTestEnv();
    // 各 endpoint が呼ばれた時刻を記録
    const callTimes: number[] = [];
    const start = Date.now();
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = (init?.method ?? "GET").toUpperCase();
      callTimes.push(Date.now() - start);
      // すべて即返す (delay 無し) が、Promise.all で並列化されていることを
      // 確認するため async 化
      await new Promise((r) => setTimeout(r, 10));
      if (url.includes("/add-version")) {
        return jsonResponse({ ok: true, new_version: "p/secrets/X/versions/1" });
      }
      if (method === "GET" && url.includes("/secrets_store/stores/")) {
        return jsonResponse({ success: true, result: [{ id: "x", name: "MY_SECRET" }] });
      }
      if (method === "PATCH" && url.includes("/secrets_store/stores/")) {
        return jsonResponse({ success: true, result: {} });
      }
      if (url.includes("/public-key")) {
        return jsonResponse({ key_id: "kid", key: TEST_GH_PUBLIC_KEY_B64 });
      }
      return new Response(null, { status: 204 });
    };

    const r = await executeRotateSecret(
      { ...baseArgs, targets: [...baseArgs.targets] },
      env,
      { fetcher },
    );
    expect(r.ok).toBe(true);
    // 3 provider が並列起動なら最初の 3 call はほぼ同時刻 (50ms 以内)
    expect(callTimes[0]!).toBeLessThan(50);
    expect(callTimes[1]!).toBeLessThan(50);
    expect(callTimes[2]!).toBeLessThan(50);
  });

  it("targets が部分集合の時、その provider だけ呼ばれる", async () => {
    const env = makeTestEnv();
    const { fetcher, calls } = stubFetcher(happyPathRoutes("X"));
    const r = await executeRotateSecret(
      {
        name: "X",
        new_value: "v",
        confirm_name: "X",
        targets: ["gcp"],
      },
      env,
      { fetcher },
    );
    expect(r.ok).toBe(true);
    expect(r.results.gcp?.status).toBe("ok");
    expect(r.results.cf).toBeUndefined();
    expect(r.results.github).toBeUndefined();
    // GCP の 1 call だけ
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("/add-version");
  });

  it("expected_gcp_version_id を GCP provider に転送する", async () => {
    const env = makeTestEnv();
    const seenHeaders: Record<string, string>[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
      return jsonResponse({ ok: true, new_version: "p/secrets/X/versions/2" });
    };
    await executeRotateSecret(
      {
        name: "X",
        new_value: "v",
        confirm_name: "X",
        targets: ["gcp"],
        expected_gcp_version_id: "7",
      },
      env,
      { fetcher },
    );
    expect(seenHeaders[0]!["X-Expected-Version-Id"]).toBe("7");
  });

  it("actorEmail を GCP provider に X-Actor-Email として転送する", async () => {
    const env = makeTestEnv();
    const seenHeaders: Record<string, string>[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
      return jsonResponse({ ok: true, new_version: "p/secrets/X/versions/2" });
    };
    await executeRotateSecret(
      {
        name: "X",
        new_value: "v",
        confirm_name: "X",
        targets: ["gcp"],
      },
      env,
      { fetcher, actorEmail: "human@example.com" },
    );
    expect(seenHeaders[0]!["X-Actor-Email"]).toBe("human@example.com");
  });

  it("new_value は rotation result の JSON に echo されない", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher(happyPathRoutes("MY_SECRET"));
    const r = await executeRotateSecret(
      {
        ...baseArgs,
        new_value: "VERY_DISTINCT_PAYLOAD_AAAA",
        targets: [...baseArgs.targets],
      },
      env,
      { fetcher },
    );
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("VERY_DISTINCT_PAYLOAD_AAAA");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
