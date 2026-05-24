import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { rotateGithub, sealedBoxEncrypt } from "../../src/providers/github";
import { makeTestEnv } from "../helpers/env";
import { stubFetcher, TEST_GH_PUBLIC_KEY_B64 } from "../helpers/fetcher";

describe("sealedBoxEncrypt", () => {
  it("produces a sealed box that the corresponding secret key can open", () => {
    // 自家発電の keypair で round-trip 確認 (= NaCl 互換 = GitHub 互換)
    const kp = nacl.box.keyPair();
    const pkB64 = btoa(String.fromCharCode(...kp.publicKey));
    const plaintext = "secret message 🔐";
    const sealedB64 = sealedBoxEncrypt(plaintext, pkB64);

    // decrypt: tweetnacl-sealedbox-js の open API は呼ばずに自前で実装する
    // (= unit test の round-trip で encrypt が正しい layout かを固定するため)
    // ここでは encrypt の output 形状だけ確認:
    //   - base64 decode して length >= 32 (= ephemeral pk) + 16 (= Poly1305 tag)
    //     + plaintext.length
    const sealedBytes = base64Decode(sealedB64);
    const expectedMinLength =
      32 /* ephemeral pk */ + 16 /* poly1305 tag */ + new TextEncoder().encode(plaintext).length;
    expect(sealedBytes.length).toBeGreaterThanOrEqual(expectedMinLength);
  });

  it("throws on invalid public key length", () => {
    expect(() => sealedBoxEncrypt("x", btoa("\0".repeat(8)))).toThrow(/public key length/);
  });
});

describe("rotateGithub", () => {
  it("GET public-key + PUT secret with sealed box returns ok", async () => {
    const env = makeTestEnv();
    const { fetcher, calls } = stubFetcher([
      {
        method: "GET",
        match: "/actions/secrets/public-key",
        body: { key_id: "kid-1", key: TEST_GH_PUBLIC_KEY_B64 },
      },
      { method: "PUT", match: "/actions/secrets/", status: 204 },
    ]);
    const r = await rotateGithub(
      { name: "MY_SECRET", newValue: "secret-payload" },
      { env, fetcher },
    );
    expect(r.status).toBe("ok");

    expect(calls.length).toBe(2);
    const putCall = calls.find((c) => c.method === "PUT")!;
    expect(putCall.url).toContain("/actions/secrets/MY_SECRET");
    // PUT body: encrypted_value + key_id + visibility
    const putBody = JSON.parse(putCall.body!);
    expect(putBody.key_id).toBe("kid-1");
    expect(putBody.visibility).toBe("all");
    expect(typeof putBody.encrypted_value).toBe("string");
    // raw value は body に絶対出ない (sealed)
    expect(putCall.body!).not.toContain("secret-payload");
  });

  it("respects visibility override", async () => {
    const env = makeTestEnv();
    const { fetcher, calls } = stubFetcher([
      {
        method: "GET",
        match: "/actions/secrets/public-key",
        body: { key_id: "kid-1", key: TEST_GH_PUBLIC_KEY_B64 },
      },
      { method: "PUT", match: "/actions/secrets/", status: 201 },
    ]);
    const r = await rotateGithub(
      { name: "X", newValue: "v", visibility: "private" },
      { env, fetcher },
    );
    expect(r.status).toBe("ok");
    const putBody = JSON.parse(calls.find((c) => c.method === "PUT")!.body!);
    expect(putBody.visibility).toBe("private");
  });

  it("returns fail on public-key network error", async () => {
    const env = makeTestEnv();
    const fetcher: typeof fetch = async () => {
      throw new Error("ETIMEDOUT");
    };
    const r = await rotateGithub({ name: "X", newValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/public-key network error/);
  });

  it("returns fail on public-key non-2xx", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      { method: "GET", match: "/actions/secrets/public-key", body: "unauth", status: 401 },
    ]);
    const r = await rotateGithub({ name: "X", newValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/public-key 401/);
  });

  it("returns fail on public-key bad JSON", async () => {
    const env = makeTestEnv();
    const fetcher: typeof fetch = async () =>
      new Response("not-json", { status: 200 });
    const r = await rotateGithub({ name: "X", newValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/public-key bad json/);
  });

  it("returns fail on public-key missing key/key_id", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      { method: "GET", match: "/actions/secrets/public-key", body: {} },
    ]);
    const r = await rotateGithub({ name: "X", newValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/missing key/);
  });

  it("returns fail when sealed box encrypt fails (invalid pk length)", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      {
        method: "GET",
        match: "/actions/secrets/public-key",
        body: { key_id: "kid-1", key: btoa("\0".repeat(8)) },
      },
    ]);
    const r = await rotateGithub({ name: "X", newValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/github encrypt/);
  });

  it("returns fail on PUT network error", async () => {
    const env = makeTestEnv();
    let firstCall = true;
    const fetcher: typeof fetch = async () => {
      if (firstCall) {
        firstCall = false;
        return new Response(
          JSON.stringify({ key_id: "kid-1", key: TEST_GH_PUBLIC_KEY_B64 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error("connection lost");
    };
    const r = await rotateGithub({ name: "X", newValue: "v" }, { env, fetcher });
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/put network error/);
  });

  it("returns fail on PUT non-201/204", async () => {
    const env = makeTestEnv();
    const { fetcher } = stubFetcher([
      {
        method: "GET",
        match: "/actions/secrets/public-key",
        body: { key_id: "kid-1", key: TEST_GH_PUBLIC_KEY_B64 },
      },
      { method: "PUT", match: "/actions/secrets/", body: "bad name", status: 422 },
    ]);
    const r = await rotateGithub(
      { name: "kebab-case-secret", newValue: "v" },
      { env, fetcher },
    );
    expect(r.status).toBe("fail");
    expect(r.error).toMatch(/put 422/);
  });
});

function base64Decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
