import { z } from "zod";
import type { Env } from "../../types";
import type { ToolContext } from "../registry";
import { SECRET_MANAGER_API, GcpUserError, callGoogleApi, userAccessToken } from "../../providers/gcp-user";

// `generate_secret` MCP tool (Refs #101)。
//
// 値を **この Worker の中で作って**、MCP にログインした人 (claude@ippoan.org) の権限で
// GCP Secret Manager に作成する。`create_secret` と違って値を引数で受け取らないので、
// 値は tool-call JSON にも応答にも載らない。返すのは公開側 (公開鍵) だけ。
//
// claude@ は普段 Secret Manager の書き込み権限を持たない。先に `request_write_access` で
// PAM の `secret-write` を申請し、承認されて ACTIVE になってから呼ぶ。承認前は 403 で、
// その旨の案内を返す。Cloudflare / GitHub への反映は、作ったあと `sync_from_gcp` で行う。

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const LABEL_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/;
const LABEL_VALUE_PATTERN = /^[a-z0-9_-]{0,63}$/;

export const SECRET_KINDS = ["random_hex32", "ec_p256_pkcs8", "vapid"] as const;
type SecretKind = (typeof SECRET_KINDS)[number];

interface Generated {
  value: string;
  /** 応答に載せてよい公開側。 */
  public: Record<string, string>;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pem(label: string, der: ArrayBuffer): string {
  const lines = base64(new Uint8Array(der)).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

async function p256(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

export async function generate(kind: SecretKind): Promise<Generated> {
  switch (kind) {
    case "random_hex32": {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      return { value: [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""), public: {} };
    }
    case "ec_p256_pkcs8": {
      const keys = await p256();
      return {
        value: pem("PRIVATE KEY", (await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer),
        public: { public_key_pem: pem("PUBLIC KEY", (await crypto.subtle.exportKey("spki", keys.publicKey)) as ArrayBuffer) },
      };
    }
    case "vapid": {
      const keys = await p256();
      const jwk = (await crypto.subtle.exportKey("jwk", keys.privateKey)) as JsonWebKey;
      const raw = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
      return { value: jwk.d!, public: { vapid_public_key: base64url(raw) } };
    }
  }
}

export const generateSecretInputSchema = z
  .object({
    name: z
      .string()
      .regex(NAME_PATTERN, "name must match ^[A-Za-z][A-Za-z0-9_-]{0,127}$")
      .describe("作る GCP secret 名 (Cloudflare 側と同名にするのが規約)"),
    kind: z
      .enum(SECRET_KINDS)
      .describe(
        "値の種類。`random_hex32` = 32 バイトの乱数 (hex 64 文字、共有シークレット・HMAC 鍵向け) / " +
          "`ec_p256_pkcs8` = ES256 秘密鍵 (PKCS#8 PEM、公開鍵 PEM を返す) / " +
          "`vapid` = Web Push の VAPID 秘密鍵 (d を base64url、公開鍵を返す)",
      ),
    labels: z
      .record(z.string().regex(LABEL_PATTERN), z.string().regex(LABEL_VALUE_PATTERN))
      .optional()
      .describe("GCP の label (例: `{\"used-by-ippoan-pam-approver\": \"active\"}`)"),
    fail_if_exists: z
      .boolean()
      .default(true)
      .describe("true (既定) で同名の secret があれば失敗。false なら新しい version を足す"),
  })
  .strict();

export const generateSecretTool = {
  name: "generate_secret",
  description:
    "値をサーバー側で作って、MCP にログインした人の権限で GCP Secret Manager に作成する。" +
    "値は tool-call にも応答にも載らず、返すのは公開鍵などの公開側だけ。先に " +
    "`request_write_access` (entitlement `secret-write`) で申請し、承認されて ACTIVE に" +
    "なってから呼ぶ。Cloudflare / GitHub への反映は作成後に `sync_from_gcp` で行う。",
  inputSchema: generateSecretInputSchema,
  requiresScope: "mcp.write" as const,
  execute: async (
    env: Env,
    args: z.infer<typeof generateSecretInputSchema>,
    actorEmail?: string,
    ctx?: ToolContext,
  ) => {
    const token = await userAccessToken(env, ctx);
    const secretPath = `projects/${env.GCP_PROJECT_ID}/secrets/${args.name}`;

    const existing = await callGoogleApi<{ name: string } | null>(token, `${SECRET_MANAGER_API}/${secretPath}`, {
      allowNotFound: true,
    });
    if (existing && args.fail_if_exists) {
      throw new GcpUserError(`secret ${args.name} は既にあります (新しい version にするなら fail_if_exists: false)`);
    }
    if (!existing) {
      const url = new URL(`${SECRET_MANAGER_API}/projects/${env.GCP_PROJECT_ID}/secrets`);
      url.searchParams.set("secretId", args.name);
      await callGoogleApi(token, url.toString(), {
        method: "POST",
        body: { replication: { automatic: {} }, ...(args.labels ? { labels: args.labels } : {}) },
      });
    }

    const generated = await generate(args.kind);
    const version = await callGoogleApi<{ name: string }>(token, `${SECRET_MANAGER_API}/${secretPath}:addVersion`, {
      method: "POST",
      body: { payload: { data: base64(new TextEncoder().encode(generated.value)) } },
    });
    console.log(
      JSON.stringify({ event: "generate_secret", name: args.name, kind: args.kind, created: !existing, actor: actorEmail }),
    );
    return {
      name: args.name,
      kind: args.kind,
      created: !existing,
      version: version.name,
      ...generated.public,
      next: "Cloudflare / GitHub に入れるなら `sync_from_gcp` を使う",
    };
  },
};
