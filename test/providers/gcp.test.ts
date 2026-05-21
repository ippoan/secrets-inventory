import { describe, it, expect, vi, afterEach } from "vitest";
import {
  listGcpSecrets,
  shortName,
  GcpProxyError,
  type GcpProxyContext,
} from "../../src/providers/gcp";

const ctx: GcpProxyContext = {
  proxyUrl: "https://secrets-inventory-gcp-stub.run.app",
  apiKey: "test-shared-secret",
};

describe("shortName", () => {
  it("strips the projects/.../secrets/ prefix", () => {
    expect(shortName("projects/foo/secrets/MY_SECRET")).toBe("MY_SECRET");
  });

  it("returns input unchanged when no slash is present", () => {
    expect(shortName("LITERAL")).toBe("LITERAL");
  });
});

describe("listGcpSecrets (Cloud Run proxy)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls proxy /list-secrets with shared-secret header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([]),
    );
    await listGcpSecrets(ctx);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://secrets-inventory-gcp-stub.run.app/list-secrets",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-Inventory-API-Key": "test-shared-secret",
        }),
      }),
    );
  });

  it("maps proxy response to SecretMetadata with short name; no value leak", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([
        {
          name: "projects/cloudsql-sv/secrets/STRIPE_API_KEY",
          create_time: "2026-01-01T00:00:00Z",
          labels: { env: "prod" },
        },
        {
          name: "projects/cloudsql-sv/secrets/OPENAI_API_KEY",
          create_time: "2026-02-01T00:00:00Z",
        },
      ]),
    );
    const items = await listGcpSecrets(ctx);
    expect(items).toHaveLength(2);
    expect(items[0]?.name).toBe("STRIPE_API_KEY");
    expect(items[0]?.created_at).toBe("2026-01-01T00:00:00Z");
    expect((items[0]?.extra as { labels: Record<string, string> }).labels.env).toBe("prod");
    for (const it of items) {
      expect(it).not.toHaveProperty("value");
    }
  });

  it("returns empty array when proxy returns []", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([]));
    const items = await listGcpSecrets(ctx);
    expect(items).toEqual([]);
  });

  it("throws GcpProxyError on 401 (wrong shared secret)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("unauthorized", { status: 401 }),
    );
    await expect(listGcpSecrets(ctx)).rejects.toThrow(GcpProxyError);
    await expect(listGcpSecrets(ctx)).rejects.toThrow(/401/);
  });

  it("throws GcpProxyError on 500 (proxy or upstream failure)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("internal error", { status: 500 }),
    );
    await expect(listGcpSecrets(ctx)).rejects.toThrow(/500/);
  });

  it("handles missing optional fields gracefully", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([{ name: "projects/p/secrets/MIN" }]),
    );
    const items = await listGcpSecrets(ctx);
    expect(items[0]?.name).toBe("MIN");
    expect(items[0]?.created_at).toBeNull();
    expect((items[0]?.extra as { labels: Record<string, string> }).labels).toEqual({});
  });
});
