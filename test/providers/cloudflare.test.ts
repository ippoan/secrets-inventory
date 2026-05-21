import { describe, it, expect, vi, afterEach } from "vitest";
import {
  cfApi,
  secretsStorePath,
  CloudflareApiError,
  listCloudflareSecrets,
  type CfContext,
} from "../../src/providers/cloudflare";

const ctx: CfContext = {
  token: "test-token",
  accountId: "acc-123",
  storeId: "store-456",
};

describe("secretsStorePath", () => {
  it("builds the collection endpoint", () => {
    expect(secretsStorePath(ctx)).toBe(
      "/accounts/acc-123/secrets_store/stores/store-456/secrets",
    );
  });

  it("builds a single-secret endpoint with suffix", () => {
    expect(secretsStorePath(ctx, "/abc-id")).toBe(
      "/accounts/acc-123/secrets_store/stores/store-456/secrets/abc-id",
    );
  });
});

describe("cfApi", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns result on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: true, result: { ok: true } }),
    );
    const data = await cfApi<{ ok: boolean }>(ctx, "GET", "/test");
    expect(data.ok).toBe(true);
  });

  it("sends bearer token and configured base URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: true, result: [] }),
    );
    await cfApi(ctx, "GET", "/x");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/x",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    );
  });

  it("throws CloudflareApiError on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("forbidden", { status: 403 }),
    );
    await expect(cfApi(ctx, "GET", "/test")).rejects.toThrow(CloudflareApiError);
  });

  it("throws when envelope.success=false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        success: false,
        result: null,
        errors: [{ code: 7003, message: "Could not route" }],
      }),
    );
    await expect(cfApi(ctx, "GET", "/test")).rejects.toThrow(/7003/);
  });

  it("falls back to 'unknown' when envelope.success=false has no errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: false, result: null }),
    );
    await expect(cfApi(ctx, "GET", "/test")).rejects.toThrow(/unknown/);
  });
});

describe("listCloudflareSecrets", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps raw API rows to SecretMetadata without leaking a value field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        success: true,
        result: [
          {
            id: "id-1",
            name: "A",
            scopes: ["workers"],
            comment: "first",
            status: "active",
            created: "2026-01-01T00:00:00Z",
            modified: "2026-01-02T00:00:00Z",
          },
          {
            id: "id-2",
            name: "B",
            // 欠損 fields に対する fallback を確認
          },
        ],
      }),
    );

    const items = await listCloudflareSecrets(ctx);
    expect(items).toHaveLength(2);
    expect(items[0]?.name).toBe("A");
    expect(items[0]?.id).toBe("id-1");
    expect(items[0]?.created_at).toBe("2026-01-01T00:00:00Z");
    expect(items[0]?.updated_at).toBe("2026-01-02T00:00:00Z");
    expect((items[0]?.extra as { scopes: string[] }).scopes).toEqual(["workers"]);
    expect(items[1]?.updated_at).toBeNull();
    for (const it of items) {
      expect(it).not.toHaveProperty("value");
    }
  });

  it("returns empty array for empty store", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: true, result: [] }),
    );
    const items = await listCloudflareSecrets(ctx);
    expect(items).toEqual([]);
  });

  it("propagates 403 from a read-only token without sufficient scope", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("forbidden", { status: 403 }),
    );
    await expect(listCloudflareSecrets(ctx)).rejects.toThrow(/403/);
  });
});
