import { describe, it, expect, vi, afterEach } from "vitest";
import {
  listServiceAccounts,
  GcpIamProxyError,
  type GcpIamProxyContext,
} from "../../src/providers/gcp-iam";

const ctx: GcpIamProxyContext = {
  proxyUrl: "https://secrets-inventory-gcp-stub.run.app",
  apiKey: "test-shared-secret",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listServiceAccounts", () => {
  it("calls proxy /list-service-accounts with shared-secret header", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ service_accounts: [] }));
    await listServiceAccounts(ctx);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://secrets-inventory-gcp-stub.run.app/list-service-accounts",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-Inventory-API-Key": "test-shared-secret",
        }),
      }),
    );
  });

  it("maps proxy response to ServiceAccount; no value/private key leak", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        service_accounts: [
          {
            email: "sa-a@p.iam.gserviceaccount.com",
            display_name: "SA A",
            description: "feature X",
            unique_id: "100",
            disabled: false,
            roles: ["roles/foo"],
            keys: [
              {
                id: "abc",
                key_type: "USER_MANAGED",
                valid_after: "2026-01-01T00:00:00Z",
                valid_before: "2027-01-01T00:00:00Z",
              },
              { id: "def", key_type: "SYSTEM_MANAGED" },
              { id: "ghi", key_type: "WEIRD_FROM_FUTURE" },
            ],
          },
          {
            email: "sa-b@p.iam.gserviceaccount.com",
            unique_id: "200",
            disabled: true,
          },
        ],
      }),
    );

    const sas = await listServiceAccounts(ctx);
    expect(sas).toHaveLength(2);
    expect(sas[0]).toMatchObject({
      email: "sa-a@p.iam.gserviceaccount.com",
      display_name: "SA A",
      description: "feature X",
      unique_id: "100",
      disabled: false,
      roles: ["roles/foo"],
    });
    expect(sas[0]!.keys).toHaveLength(3);
    expect(sas[0]!.keys[0]).toEqual({
      id: "abc",
      key_type: "USER_MANAGED",
      valid_after: "2026-01-01T00:00:00Z",
      valid_before: "2027-01-01T00:00:00Z",
    });
    expect(sas[0]!.keys[2]!.key_type).toBe("KEY_TYPE_UNSPECIFIED");

    // sa-b は最低限 field のみ。roles/keys は default で空配列。
    expect(sas[1]!.roles).toEqual([]);
    expect(sas[1]!.keys).toEqual([]);
    expect(sas[1]!.disabled).toBe(true);
  });

  it("handles empty envelope (service_accounts undefined)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    const sas = await listServiceAccounts(ctx);
    expect(sas).toEqual([]);
  });

  it("throws GcpIamProxyError on non-OK response", async () => {
    // Response は body を一度しか consume できないので毎呼び出しで fresh を返す
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("boom", { status: 502 }),
    );
    let caught: unknown;
    try {
      await listServiceAccounts(ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GcpIamProxyError);
    const e = caught as GcpIamProxyError;
    expect(e.status).toBe(502);
    expect(e.message).toMatch(/502/);
    expect(e.message).toMatch(/boom/);
  });
});
