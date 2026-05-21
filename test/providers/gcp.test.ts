import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import {
  parseServiceAccountKey,
  buildJwtAssertion,
  fetchAccessToken,
  listGcpSecrets,
  shortName,
  GcpApiError,
  type GcpServiceAccountKey,
} from "../../src/providers/gcp";

/**
 * テスト用に Web Crypto で実 RSA 鍵を 1 つだけ生成し、PEM (PKCS8) で再利用する。
 * 各テストで生成すると遅いので beforeAll で 1 回だけ。
 */
let testKey: GcpServiceAccountKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey(
    "pkcs8",
    pair.privateKey,
  )) as ArrayBuffer;
  const pem = toPem(pkcs8);
  testKey = {
    type: "service_account",
    project_id: "test-project",
    private_key_id: "kid-1",
    private_key: pem,
    client_email: "sa@test-project.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
  };
});

function toPem(pkcs8: ArrayBuffer): string {
  const bin = String.fromCharCode(...new Uint8Array(pkcs8));
  const b64 = btoa(bin);
  const wrapped = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
}

describe("shortName", () => {
  it("strips the projects/.../secrets/ prefix", () => {
    expect(shortName("projects/foo/secrets/MY_SECRET")).toBe("MY_SECRET");
  });

  it("returns input unchanged when no slash is present", () => {
    expect(shortName("LITERAL")).toBe("LITERAL");
  });
});

describe("parseServiceAccountKey", () => {
  it("parses valid JSON", () => {
    const json = JSON.stringify({
      private_key: "k",
      client_email: "x@y.iam.gserviceaccount.com",
    });
    const parsed = parseServiceAccountKey(json);
    expect(parsed.client_email).toBe("x@y.iam.gserviceaccount.com");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseServiceAccountKey("not json")).toThrow(GcpApiError);
  });

  it("throws when private_key is missing", () => {
    expect(() =>
      parseServiceAccountKey(
        JSON.stringify({ client_email: "x@y.iam.gserviceaccount.com" }),
      ),
    ).toThrow(/private_key/);
  });

  it("throws when client_email is missing", () => {
    expect(() =>
      parseServiceAccountKey(JSON.stringify({ private_key: "k" })),
    ).toThrow(/client_email/);
  });

  it("throws when JSON is not an object (null)", () => {
    expect(() => parseServiceAccountKey("null")).toThrow(/not an object/);
  });
});

describe("buildJwtAssertion", () => {
  it("produces a 3-segment JWT signed with RS256 over the SA key", async () => {
    const nowSec = 1_700_000_000;
    const jwt = await buildJwtAssertion(
      testKey,
      "https://www.googleapis.com/auth/cloud-platform.read-only",
      nowSec,
    );
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    const header = JSON.parse(b64urlDecode(parts[0]!));
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");
    expect(header.kid).toBe("kid-1");

    const payload = JSON.parse(b64urlDecode(parts[1]!));
    expect(payload.iss).toBe(testKey.client_email);
    expect(payload.iat).toBe(nowSec);
    expect(payload.exp).toBe(nowSec + 3600);
    expect(payload.aud).toBe("https://oauth2.googleapis.com/token");
  });
});

describe("fetchAccessToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs assertion to token endpoint and returns access_token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        access_token: "ya29.fake",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    const token = await fetchAccessToken(testKey, 1_700_000_000);
    expect(token).toBe("ya29.fake");
    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe("https://oauth2.googleapis.com/token");
    expect((call[1] as RequestInit).method).toBe("POST");
  });

  it("throws GcpApiError when token endpoint returns non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("invalid_grant", { status: 400 }),
    );
    await expect(fetchAccessToken(testKey, 1_700_000_000)).rejects.toThrow(
      /400/,
    );
  });
});

describe("listGcpSecrets", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns metadata with short name; no value field", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          access_token: "ya29.fake",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          secrets: [
            {
              name: "projects/test-project/secrets/STRIPE_API_KEY",
              createTime: "2026-01-01T00:00:00Z",
              labels: { env: "prod" },
            },
            {
              name: "projects/test-project/secrets/OPENAI_API_KEY",
              createTime: "2026-02-01T00:00:00Z",
            },
          ],
        }),
      );

    const items = await listGcpSecrets({
      serviceAccountKey: testKey,
      projectId: "test-project",
    });
    expect(items).toHaveLength(2);
    expect(items[0]?.name).toBe("STRIPE_API_KEY");
    expect((items[0]?.extra as { labels: Record<string, string> }).labels.env).toBe(
      "prod",
    );
    for (const it of items) {
      expect(it).not.toHaveProperty("value");
    }
    expect(fetchSpy.mock.calls[1]?.[0]).toEqual(
      expect.stringContaining(
        "/v1/projects/test-project/secrets?pageSize=100",
      ),
    );
  });

  it("paginates with nextPageToken", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          access_token: "ya29.fake",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          secrets: [
            { name: "projects/p/secrets/A", createTime: "2026-01-01T00:00:00Z" },
          ],
          nextPageToken: "PAGE2",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          secrets: [
            { name: "projects/p/secrets/B", createTime: "2026-01-02T00:00:00Z" },
          ],
        }),
      );

    const items = await listGcpSecrets({
      serviceAccountKey: testKey,
      projectId: "p",
    });
    expect(items.map((s) => s.name)).toEqual(["A", "B"]);
    expect(fetchSpy.mock.calls[2]?.[0]).toEqual(
      expect.stringContaining("pageToken=PAGE2"),
    );
  });

  it("propagates 403 from viewer SA hitting access endpoint (defense)", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          access_token: "ya29.fake",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      )
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

    await expect(
      listGcpSecrets({
        serviceAccountKey: testKey,
        projectId: "p",
      }),
    ).rejects.toThrow(/403/);
  });
});

function b64urlDecode(s: string): string {
  const padded = s + "===".slice((s.length + 3) % 4);
  return atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
}
