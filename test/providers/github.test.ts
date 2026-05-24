import { describe, it, expect, vi, afterEach } from "vitest";
import {
  listGitHubOrgSecrets,
  rotateGithub,
  createGithub,
  GithubProxyError,
  type GhProxyContext,
} from "../../src/providers/github";

const ctx: GhProxyContext = {
  proxyUrl: "https://gcp-stub.run.app",
  apiKey: "shared-secret",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listGitHubOrgSecrets (via proxy)", () => {
  it("calls the proxy list endpoint with X-Inventory-API-Key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ secrets: [] }),
    );
    await listGitHubOrgSecrets(ctx);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://gcp-stub.run.app/gh/secrets",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-Inventory-API-Key": "shared-secret",
        }),
      }),
    );
  });

  it("maps secrets to SecretMetadata with visibility in extra", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        secrets: [
          {
            name: "DEPLOY_KEY",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-02-01T00:00:00Z",
            visibility: "all",
          },
          {
            name: "NPM_TOKEN",
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
            visibility: "selected",
          },
        ],
      }),
    );
    const items = await listGitHubOrgSecrets(ctx);
    expect(items).toHaveLength(2);
    expect(items[0]?.name).toBe("DEPLOY_KEY");
    expect((items[0]?.extra as { visibility: string }).visibility).toBe("all");
    for (const it of items) {
      expect(it).not.toHaveProperty("value");
    }
  });

  it("throws GithubProxyError on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );
    await expect(listGitHubOrgSecrets(ctx)).rejects.toThrow(GithubProxyError);
  });
});

describe("rotateGithub (via proxy)", () => {
  it("PUTs /gh/secrets/{name} with raw value (encrypt is proxy-side)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: true }),
    );
    const res = await rotateGithub({ name: "MY_SECRET", newValue: "raw-val" }, ctx);
    expect(res.status).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://gcp-stub.run.app/gh/secrets/MY_SECRET",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining("raw-val"),
      }),
    );
    // X-Fail-If-Exists は rotate path では立てない (= 冪等上書き)
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["X-Fail-If-Exists"]).toBeUndefined();
  });

  it("encodes the secret name in the URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: true }),
    );
    await rotateGithub({ name: "a-b/c", newValue: "v" }, ctx);
    expect(fetchSpy.mock.calls[0]?.[0]).toContain("a-b%2Fc");
  });

  it("fail on proxy 502", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("oops", { status: 502 }),
    );
    const res = await rotateGithub({ name: "X", newValue: "v" }, ctx);
    expect(res.status).toBe("fail");
    expect(res.error).toMatch(/502/);
  });
});

describe("createGithub (via proxy)", () => {
  it("sends X-Fail-If-Exists header by default (true)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: true, created: true }),
    );
    const res = await createGithub({ name: "NEW_ONE", initialValue: "v" }, ctx);
    expect(res.status).toBe("ok");
    expect(res.created).toBe(true);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["X-Fail-If-Exists"]).toBe("true");
  });

  it("conflict (409) → fail with 'already exists'", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("conflict", { status: 409 }),
    );
    const res = await createGithub({ name: "DUP", initialValue: "v" }, ctx);
    expect(res.status).toBe("fail");
    expect(res.error).toMatch(/already exists/i);
  });

  it("fail_if_exists=false → no header + created=false", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: true, created: false }),
    );
    const res = await createGithub(
      { name: "EXISTING", initialValue: "v", failIfExists: false },
      ctx,
    );
    expect(res.status).toBe("ok");
    expect(res.created).toBe(false);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["X-Fail-If-Exists"]).toBeUndefined();
  });
});
