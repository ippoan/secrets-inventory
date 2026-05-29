import { describe, it, expect, vi, afterEach } from "vitest";
import {
  listCloudflareSecrets,
  listCloudflareServiceTokens,
  rotateCloudflare,
  createCloudflare,
  rotateCloudflareServiceToken,
  deleteCloudflareServiceToken,
  createCloudflareServiceToken,
  CloudflareProxyError,
  type CfProxyContext,
} from "../../src/providers/cloudflare";

const ctx: CfProxyContext = {
  proxyUrl: "https://gcp-stub.run.app",
  apiKey: "shared-secret",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listCloudflareSecrets (via proxy)", () => {
  it("maps proxy rows to SecretMetadata without leaking a value field", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("https://gcp-stub.run.app/cf/secrets");
      return Response.json({
        secrets: [
          {
            id: "id-1",
            name: "A",
            scopes: ["workers"],
            comment: "first",
            status: "active",
            created: "2026-01-01T00:00:00Z",
            modified: "2026-01-02T00:00:00Z",
          },
          { id: "id-2", name: "B" },
        ],
      });
    });

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

  it("sends X-Inventory-API-Key header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ secrets: [] }),
    );
    await listCloudflareSecrets(ctx);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>)?.["X-Inventory-API-Key"]).toBe(
      "shared-secret",
    );
  });

  it("throws CloudflareProxyError on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream error", { status: 502 }),
    );
    await expect(listCloudflareSecrets(ctx)).rejects.toThrow(CloudflareProxyError);
  });
});

describe("rotateCloudflare (via proxy)", () => {
  it("resolves id via list then POSTs /cf/secrets/{id}", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/cf/secrets")) {
        return Response.json({ secrets: [{ id: "id-target", name: "TARGET" }] });
      }
      if (url.endsWith("/cf/secrets/id-target")) {
        return Response.json({ ok: true, secret_id: "id-target" });
      }
      return new Response("unexpected", { status: 500 });
    });

    const res = await rotateCloudflare({ name: "TARGET", newValue: "new-val" }, ctx);
    expect(res.status).toBe("ok");
    expect(res.secret_id).toBe("id-target");
    const rotateCall = fetchSpy.mock.calls.find(([url]) =>
      typeof url === "string" && url.endsWith("/cf/secrets/id-target"),
    );
    expect(rotateCall).toBeDefined();
    const body = (rotateCall?.[1] as RequestInit | undefined)?.body as string;
    expect(body).toContain("new-val");
  });

  it("fail when secret not found", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ secrets: [{ id: "x", name: "OTHER" }] }),
    );
    const res = await rotateCloudflare({ name: "MISSING", newValue: "v" }, ctx);
    expect(res.status).toBe("fail");
    expect(res.error).toMatch(/not found/i);
  });

  it("fail when proxy rotate endpoint returns 502", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/cf/secrets")) {
        return Response.json({ secrets: [{ id: "x", name: "T" }] });
      }
      return new Response("oops", { status: 502 });
    });
    const res = await rotateCloudflare({ name: "T", newValue: "v" }, ctx);
    expect(res.status).toBe("fail");
    expect(res.error).toMatch(/502/);
  });
});

describe("createCloudflare (via proxy)", () => {
  it("creates new secret when name doesn't exist", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/cf/secrets") && init?.method === "GET") {
        return Response.json({ secrets: [] });
      }
      if (url.endsWith("/cf/secrets") && init?.method === "POST") {
        return Response.json({ ok: true, secret_id: "new-id" });
      }
      return new Response("unexpected", { status: 500 });
    });

    const res = await createCloudflare(
      { name: "NEW_ONE", initialValue: "v" },
      ctx,
    );
    expect(res.status).toBe("ok");
    expect(res.created).toBe(true);
    expect(res.secret_id).toBe("new-id");

    const postCall = fetchSpy.mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    expect(postCall).toBeDefined();
    expect(postCall?.[1]?.body as string).toContain("NEW_ONE");
  });

  it("fail_if_exists=true → fail when name already exists", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ secrets: [{ id: "x", name: "DUP" }] }),
    );
    const res = await createCloudflare(
      { name: "DUP", initialValue: "v", failIfExists: true },
      ctx,
    );
    expect(res.status).toBe("fail");
    expect(res.error).toMatch(/already exists/i);
  });

  it("fail_if_exists=false → reuse existing (= rotate path) and created=false", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/cf/secrets") && init?.method === "GET") {
        return Response.json({ secrets: [{ id: "existing-id", name: "DUP" }] });
      }
      if (url.endsWith("/cf/secrets/existing-id")) {
        return Response.json({ ok: true, secret_id: "existing-id" });
      }
      return new Response("unexpected", { status: 500 });
    });
    const res = await createCloudflare(
      { name: "DUP", initialValue: "v", failIfExists: false },
      ctx,
    );
    expect(res.status).toBe("ok");
    expect(res.created).toBe(false);
    expect(res.secret_id).toBe("existing-id");
  });
});

describe("listCloudflareServiceTokens (via proxy)", () => {
  it("maps proxy service_tokens to SecretMetadata with kind=service_token", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("https://gcp-stub.run.app/cf/service-tokens");
      return Response.json({
        service_tokens: [
          {
            id: "st-1",
            name: "testone",
            client_id: "abc.access",
            duration: "8760h",
            created: "2026-01-01T00:00:00Z",
            modified: "2026-05-01T00:00:00Z",
          },
          { id: "st-2", name: "api" },
        ],
      });
    });

    const items = await listCloudflareServiceTokens(ctx);
    expect(items).toHaveLength(2);
    expect(items[0]?.name).toBe("testone");
    expect(items[0]?.id).toBe("st-1");
    expect(items[0]?.created_at).toBe("2026-01-01T00:00:00Z");
    expect(items[0]?.updated_at).toBe("2026-05-01T00:00:00Z");
    const extra0 = items[0]?.extra as {
      kind: string;
      client_id: string | null;
      duration: string | null;
    };
    expect(extra0.kind).toBe("service_token");
    expect(extra0.client_id).toBe("abc.access");
    expect(extra0.duration).toBe("8760h");
    // 欠落 field は null fallback
    const extra1 = items[1]?.extra as { client_id: string | null };
    expect(items[1]?.updated_at).toBeNull();
    expect(extra1.client_id).toBeNull();
    // client_secret は構造的に返らない
    for (const it of items) {
      expect(JSON.stringify(it)).not.toContain("client_secret");
    }
  });

  it("returns [] when service_tokens key is absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    await expect(listCloudflareServiceTokens(ctx)).resolves.toEqual([]);
  });

  it("sends X-Inventory-API-Key header", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ service_tokens: [] }));
    await listCloudflareServiceTokens(ctx);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(
      (init?.headers as Record<string, string>)?.["X-Inventory-API-Key"],
    ).toBe("shared-secret");
  });

  it("throws CloudflareProxyError on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream error", { status: 502 }),
    );
    await expect(listCloudflareServiceTokens(ctx)).rejects.toThrow(
      CloudflareProxyError,
    );
  });
});

describe("rotateCloudflareServiceToken (via proxy)", () => {
  it("POSTs /cf/service-tokens/{id}/rotate with sm_secret_name and returns metadata (no secret)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("https://gcp-stub.run.app/cf/service-tokens/st-1/rotate");
      expect(init?.method).toBe("POST");
      return Response.json({
        ok: true,
        token_id: "st-1",
        client_id: "abc.access",
        expires_at: "2027-01-01T00:00:00Z",
        client_secret_version: 2,
        sm_secret_name: "foo-client-secret",
        sm_version: "projects/p/secrets/foo-client-secret/versions/3",
        created: false,
      });
    });
    const res = await rotateCloudflareServiceToken(
      { tokenId: "st-1", smSecretName: "foo-client-secret" },
      ctx,
    );
    expect(res.status).toBe("ok");
    expect(res.token_id).toBe("st-1");
    expect(res.sm_version).toContain("versions/3");
    expect(res.created).toBe(false);
    // request body に sm_secret_name + fail_if_exists が乗る (client_secret は扱わない)
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).toEqual({ sm_secret_name: "foo-client-secret", fail_if_exists: false });
    // 戻り値に client_secret 的フィールドが無い
    expect(JSON.stringify(res)).not.toContain("client_secret\"");
  });

  it("fail on non-2xx proxy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("scope", { status: 502 }));
    const res = await rotateCloudflareServiceToken({ tokenId: "st-1", smSecretName: "foo" }, ctx);
    expect(res.status).toBe("fail");
    expect(res.error).toMatch(/502/);
  });

  it("fail when proxy returns ok=false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: false }));
    const res = await rotateCloudflareServiceToken({ tokenId: "st-1", smSecretName: "foo" }, ctx);
    expect(res.status).toBe("fail");
  });
});

describe("deleteCloudflareServiceToken (via proxy)", () => {
  it("DELETEs /cf/service-tokens/{id} and returns ok", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("https://gcp-stub.run.app/cf/service-tokens/st-9");
      expect(init?.method).toBe("DELETE");
      return Response.json({ ok: true, token_id: "st-9" });
    });
    const res = await deleteCloudflareServiceToken({ tokenId: "st-9" }, ctx);
    expect(res.status).toBe("ok");
    expect(res.token_id).toBe("st-9");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("appends sm_secret_name query and surfaces label_applied", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe(
        "https://gcp-stub.run.app/cf/service-tokens/st-9?sm_secret_name=foo-client-secret",
      );
      expect(init?.method).toBe("DELETE");
      return Response.json({
        ok: true,
        token_id: "st-9",
        sm_secret_name: "foo-client-secret",
        label_applied: true,
      });
    });
    const res = await deleteCloudflareServiceToken(
      { tokenId: "st-9", smSecretName: "foo-client-secret" },
      ctx,
    );
    expect(res.status).toBe("ok");
    expect(res.sm_secret_name).toBe("foo-client-secret");
    expect(res.label_applied).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("fail on non-2xx proxy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 502 }));
    const res = await deleteCloudflareServiceToken({ tokenId: "st-9" }, ctx);
    expect(res.status).toBe("fail");
    expect(res.error).toMatch(/502/);
  });
});

describe("createCloudflareServiceToken (via proxy)", () => {
  it("POSTs /cf/service-tokens with name + sm_secret_name and returns metadata (no secret)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("https://gcp-stub.run.app/cf/service-tokens");
      expect(init?.method).toBe("POST");
      return Response.json({
        ok: true,
        token_id: "st-new",
        name: "ohishi-dtako-prod-api-202605",
        client_id: "new.access",
        expires_at: "2027-05-29T00:00:00Z",
        sm_secret_name: "dtako-api-client-secret",
        sm_version: "projects/p/secrets/dtako-api-client-secret/versions/1",
        created: true,
      });
    });
    const res = await createCloudflareServiceToken(
      {
        name: "ohishi-dtako-prod-api-202605",
        smSecretName: "dtako-api-client-secret",
        duration: "8760h",
      },
      ctx,
    );
    expect(res.status).toBe("ok");
    expect(res.token_id).toBe("st-new");
    expect(res.name).toBe("ohishi-dtako-prod-api-202605");
    expect(res.created).toBe(true);
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).toMatchObject({
      name: "ohishi-dtako-prod-api-202605",
      sm_secret_name: "dtako-api-client-secret",
      duration: "8760h",
      fail_if_exists: false,
    });
    expect(JSON.stringify(res)).not.toContain("client_secret\"");
  });

  it("omits duration from body when not provided", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true, token_id: "st-x" }));
    await createCloudflareServiceToken({ name: "foo", smSecretName: "bar" }, ctx);
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("duration");
  });

  it("fail on non-2xx proxy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("scope", { status: 502 }));
    const res = await createCloudflareServiceToken({ name: "foo", smSecretName: "bar" }, ctx);
    expect(res.status).toBe("fail");
    expect(res.error).toMatch(/502/);
  });
});
