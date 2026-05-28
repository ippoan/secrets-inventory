import { z } from "zod";
import type { Env } from "../../types";
import {
  convertPkcs8,
  gcpProxyCtxFromEnv,
  type ConvertPkcs8Result,
  type ConvertPkcs8Target,
} from "../../providers/gcp";

// `convert_secret_pkcs8` MCP tool: GCP にある RSA 秘密鍵 (PKCS#1) を PKCS#8 に
// 変換し、別名で保存 + 任意で GitHub に propagate する。
//
// 動機:
//   GitHub App が download させる private key は PKCS#1
//   (`-----BEGIN RSA PRIVATE KEY-----`)。`actions/create-github-app-token@v2`
//   は内部 WebCrypto が PKCS#8 のみ受理するため、PKCS#1 を渡すと
//   "Invalid keyData" で落ちる。この tool で PKCS#8 に変換した別 secret を
//   用意し、それを GitHub Actions org secret に入れる。
//
// 設計:
//   値 (鍵) は proxy 内で読み取り・変換・書き込みが完結し、tool-call JSON /
//   response / log には一切載らない (sync_from_gcp と同じ no-value-in-context
//   設計)。元の PKCS#1 secret は dst_name と別名なので温存される。
//
// Refs ippoan/secrets-inventory#59

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

export const convertPkcs8InputSchema = z
  .object({
    name: z
      .string()
      .regex(NAME_PATTERN, "name must match ^[A-Za-z][A-Za-z0-9_-]{0,127}$")
      .describe("GCP source secret 名 (PKCS#1 RSA 秘密鍵、= GitHub App の download 鍵)"),
    dst_name: z
      .string()
      .regex(NAME_PATTERN)
      .describe("変換後 (PKCS#8) を保存する別名。既存なら新 version を投入。src と同名は不可。"),
    targets: z
      .array(z.enum(["gcp", "gh"]))
      .optional()
      .describe("伝播先。`gcp` 必須 (省略時 ['gcp'])、`gh` = GitHub Actions org secret にも入れる。"),
    gh_name: z
      .string()
      .regex(NAME_PATTERN)
      .optional()
      .describe("GitHub 側 secret 名 (省略時は dst_name)"),
  })
  .strict();

export type ConvertPkcs8ToolArgs = z.infer<typeof convertPkcs8InputSchema>;

export const convertPkcs8Tool = {
  name: "convert_secret_pkcs8",
  description:
    "GCP の RSA 秘密鍵 (PKCS#1 形式、= GitHub App が download させる鍵) を " +
    "PKCS#8 形式に変換し、別名 dst_name で GCP に保存 (既存なら version-up)、" +
    "任意で GitHub Actions org secret にも入れる。値は proxy 内で完結し " +
    "tool-call JSON / response / log に載らない。用途: " +
    "`actions/create-github-app-token@v2` の 'Invalid keyData' (WebCrypto は " +
    "PKCS#8 のみ受理) 対策。元の PKCS#1 secret は温存される。" +
    "HTTP route は `POST /mcp/convert-pkcs8/:name?dst_name=...&targets=gcp,gh`。",
  inputSchema: convertPkcs8InputSchema,
  requiresScope: "mcp.write" as const,
  execute: async (
    env: Env,
    args: ConvertPkcs8ToolArgs,
    actorEmail?: string,
  ): Promise<ConvertPkcs8Result> => {
    const ctx = await gcpProxyCtxFromEnv(env, actorEmail);
    return await convertPkcs8(
      {
        srcName: args.name,
        dstName: args.dst_name,
        targets: args.targets as ConvertPkcs8Target[] | undefined,
        ghName: args.gh_name,
      },
      ctx,
    );
  },
} as const;
