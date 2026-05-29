import { z } from "zod";
import type { Env } from "../../types";
import {
  rotateCloudflareServiceToken,
  deleteCloudflareServiceToken,
  cfProxyCtxFromEnv,
  type CfServiceTokenWriteResult,
} from "../../providers/cloudflare";
import { NAME_PATTERN } from "./create-secret";

// Phase 2 (Refs #64): CF Access Service Token の rotate / delete write tool。
//
// - rotate: 新 client_secret は **proxy → GCP SM 直書き**で worker / LLM
//   context を経由しない (proxy #40)。tool は token_id と着地先 SM 名だけ扱う。
// - delete: 野良 token の revoke。
//
// いずれも:
//   - `requiresScope: "mcp.write"` (binding_jwt scope check)
//   - type-to-confirm (`confirm_token_id` が `token_id` と一致しないと reject)
//   - **自殺トークン対策**: env `CF_SERVICE_TOKEN_PROTECTED_IDS` に列挙された
//     token id は rotate/delete を拒否する (管理系 / 現役で消すと困る token)。

/**
 * CF service token id の検証パターン。CF の service token id は UUID 形式だが、
 * proxy 側 (`cfSecretIDPattern`) と揃えて緩めに `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`
 * を許容する (= path injection 文字を弾く最小 validate)。
 */
export const TOKEN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** env のカンマ区切り protected id を Set にパースする (空白 trim / 空要素無視)。 */
export function parseProtectedTokenIds(env: Env): Set<string> {
  const raw = env.CF_SERVICE_TOKEN_PROTECTED_IDS;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

function protectedFail(tokenId: string): CfServiceTokenWriteResult {
  return {
    status: "fail",
    token_id: tokenId,
    error:
      "token id is in CF_SERVICE_TOKEN_PROTECTED_IDS (refused as a self-/critical-token guard)",
  };
}

// --- rotate_service_token --------------------------------------------------

export const rotateServiceTokenInputSchema = z
  .object({
    token_id: z
      .string()
      .regex(TOKEN_ID_PATTERN, "token_id must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
      .describe("rotate 対象の CF service token id (= list_inventory / get_drift の id)"),
    sm_secret_name: z
      .string()
      .regex(NAME_PATTERN, "sm_secret_name must match ^[A-Za-z][A-Za-z0-9_-]{0,127}$")
      .describe(
        "新 client_secret を保管する GCP Secret Manager short name。" +
          "cf_token_id ラベル台帳と連動させる着地先。値は proxy→SM 直書きで context に載らない。",
      ),
    confirm_token_id: z
      .string()
      .describe("type-to-confirm: token_id と一致する文字列。不一致なら invalid_params。"),
    fail_if_exists: z
      .boolean()
      .optional()
      .describe("SM 側既存衝突を 409(true) か 既存再利用=新 version(false)。default false。"),
  })
  .strict()
  .refine((d) => d.confirm_token_id === d.token_id, {
    message: "confirm_token_id does not match token_id",
    path: ["confirm_token_id"],
  });

export type RotateServiceTokenArgs = z.infer<typeof rotateServiceTokenInputSchema>;

export const rotateServiceTokenTool = {
  name: "rotate_service_token",
  description:
    "CF Access Service Token を rotate する (新 client_secret を発行 → proxy が " +
    "GCP Secret Manager の sm_secret_name に直書き)。**新 client_secret は LLM " +
    "context / response / log に一切載らない** (proxy→SM 経路)。type-to-confirm " +
    "(confirm_token_id) 必須。CF_SERVICE_TOKEN_PROTECTED_IDS の token は拒否。Refs #64。",
  inputSchema: rotateServiceTokenInputSchema,
  requiresScope: "mcp.write" as const,
  execute: async (
    env: Env,
    args: RotateServiceTokenArgs,
    actorEmail?: string,
  ): Promise<CfServiceTokenWriteResult> => {
    if (parseProtectedTokenIds(env).has(args.token_id)) {
      return protectedFail(args.token_id);
    }
    const ctx = await cfProxyCtxFromEnv(env, actorEmail);
    return await rotateCloudflareServiceToken(
      {
        tokenId: args.token_id,
        smSecretName: args.sm_secret_name,
        failIfExists: args.fail_if_exists,
      },
      ctx,
    );
  },
} as const;

// --- delete_service_token --------------------------------------------------

export const deleteServiceTokenInputSchema = z
  .object({
    token_id: z
      .string()
      .regex(TOKEN_ID_PATTERN, "token_id must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
      .describe("delete (revoke) 対象の CF service token id"),
    confirm_token_id: z
      .string()
      .describe("type-to-confirm: token_id と一致する文字列。不一致なら invalid_params。"),
  })
  .strict()
  .refine((d) => d.confirm_token_id === d.token_id, {
    message: "confirm_token_id does not match token_id",
    path: ["confirm_token_id"],
  });

export type DeleteServiceTokenArgs = z.infer<typeof deleteServiceTokenInputSchema>;

export const deleteServiceTokenTool = {
  name: "delete_service_token",
  description:
    "CF Access Service Token を delete (revoke) する (= 野良 token 掃除)。" +
    "**この token に依存するサービスは到達不能になる**ので type-to-confirm " +
    "(confirm_token_id) 必須。CF_SERVICE_TOKEN_PROTECTED_IDS の token は拒否。" +
    "hyperdrive-* など現役 token を誤爆しないよう get_drift で確認してから実行すること。Refs #64。",
  inputSchema: deleteServiceTokenInputSchema,
  requiresScope: "mcp.write" as const,
  execute: async (
    env: Env,
    args: DeleteServiceTokenArgs,
    actorEmail?: string,
  ): Promise<CfServiceTokenWriteResult> => {
    if (parseProtectedTokenIds(env).has(args.token_id)) {
      return protectedFail(args.token_id);
    }
    const ctx = await cfProxyCtxFromEnv(env, actorEmail);
    return await deleteCloudflareServiceToken({ tokenId: args.token_id }, ctx);
  },
} as const;
