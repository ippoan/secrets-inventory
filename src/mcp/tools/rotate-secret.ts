import { z } from "zod";
import type { Env } from "../../types";
import { rotateGcp, gcpProxyCtxFromEnv } from "../../providers/gcp";
import { rotateCloudflare, cfProxyCtxFromEnv } from "../../providers/cloudflare";
import { rotateGithub, ghProxyCtxFromEnv } from "../../providers/github";
import {
  NAME_PATTERN as SHARED_NAME_PATTERN,
  ROTATION_TARGETS as SHARED_ROTATION_TARGETS,
  type RotationTarget,
} from "./create-secret";

// Refs #45 Stage 2: `packages/rotate-mcp` の rotate_secret tool を親 worker
// `/mcp` route に統合した。3 provider 全部 GCP Cloud Run proxy 経由に統一
// されたため、CF / GH の write も `secrets-inventory-gcp` の `/cf/secrets/{id}`
// と `/gh/secrets/{name}` を叩く (= worker が CF/GH トークンを持たない)。
//
// write tool 扱い: `requiresScope: "mcp.write"` を立て、binding_jwt の scope
// に mcp.write が含まれていなければ MCP server 側 dispatcher で 403 相当の
// JSONRPC error を返す。
//
// HTTP body 経由 (`PUT /mcp/secret-upload/:name?mode=rotate&...`) からも
// `executeRotate` を共有する (= LLM agent の tool-call JSON に value を
// 載せず curl --data-binary で送る経路を提供するため)。

const NAME_PATTERN = SHARED_NAME_PATTERN;
const ROTATION_TARGETS = SHARED_ROTATION_TARGETS;

export interface ProviderResult {
  status: "ok" | "fail" | "skipped";
  new_version?: string;
  secret_id?: string;
  error?: string;
}

export interface RotateResult {
  ok: boolean;
  rotation_id: string;
  dry_run: boolean;
  results: Partial<Record<RotationTarget, ProviderResult>>;
}

/** `new_value` を持つ最終形の rotate_secret 引数。MCP tool / HTTP route 共通。 */
export interface ResolvedRotateArgs {
  name: string;
  new_value: string;
  targets: readonly RotationTarget[];
  expected_gcp_version_id?: string;
}

export async function executeRotate(
  env: Env,
  args: ResolvedRotateArgs,
  actorEmail?: string,
): Promise<RotateResult> {
  const rotationId = newRotationId("rot");
  const pending: Array<Promise<[RotationTarget, ProviderResult]>> = [];
  for (const target of args.targets) {
    pending.push(runProvider(target, args, env, actorEmail).then((r) => [target, r]));
  }
  const settled = await Promise.all(pending);
  const results: RotateResult["results"] = {};
  let ok = true;
  for (const [target, result] of settled) {
    results[target] = result;
    if (result.status !== "ok") ok = false;
  }
  return { ok, rotation_id: rotationId, dry_run: false, results };
}

export const rotateSecretInputSchema = z
  .object({
    name: z
      .string()
      .regex(NAME_PATTERN, "name must match ^[A-Za-z][A-Za-z0-9_-]{0,127}$")
      .describe("secret 名 (SCREAMING_SNAKE / kebab-case、先頭は英字)"),
    new_value: z
      .string()
      .min(1)
      .max(65536)
      .describe("新しい値。response / log に echo されない。"),
    targets: z
      .array(z.enum(ROTATION_TARGETS))
      .min(1)
      .default([...ROTATION_TARGETS])
      .describe("更新対象 provider 群。省略時は 3 system すべて。"),
    confirm_name: z
      .string()
      .describe("type-to-confirm: name と一致する文字列。不一致なら invalid_params。"),
    expected_gcp_version_id: z
      .string()
      .optional()
      .describe("TOCTOU 検証用。指定すると GCP 側 version_id がこれと一致する時のみ更新。"),
  })
  .strict()
  .refine((d) => d.confirm_name === d.name, {
    message: "confirm_name does not match name",
    path: ["confirm_name"],
  });

export type RotateSecretArgs = z.infer<typeof rotateSecretInputSchema>;

export const rotateSecretTool = {
  name: "rotate_secret",
  description:
    "GCP Secret Manager を source of truth として、新値を 3 system に投入。" +
    "type-to-confirm / TOCTOU 検証込み。Refs #45 で 3 provider すべて " +
    "Cloud Run proxy 経由に統一。" +
    "LLM agent の tool-call JSON に value を載せたくない場合は HTTP route " +
    "`PUT /mcp/secret-upload/:name?mode=rotate&targets=...` に curl で直接送れる。",
  inputSchema: rotateSecretInputSchema,
  requiresScope: "mcp.write" as const,
  execute: async (env: Env, args: RotateSecretArgs, actorEmail?: string): Promise<RotateResult> => {
    return await executeRotate(
      env,
      {
        name: args.name,
        new_value: args.new_value,
        targets: args.targets,
        expected_gcp_version_id: args.expected_gcp_version_id,
      },
      actorEmail,
    );
  },
} as const;

// dry_run_rotate: 実 write をせず、各 provider に対して "skipped" を返す。
// rotate_secret の subset で confirm_name / new_value は不要 (内部で
// placeholder を入れて validate を通す)。read-only なので scope 制約無し。

export const dryRunRotateInputSchema = z
  .object({
    name: z
      .string()
      .regex(NAME_PATTERN, "name must match ^[A-Za-z][A-Za-z0-9_-]{0,127}$"),
    targets: z
      .array(z.enum(ROTATION_TARGETS))
      .min(1)
      .default([...ROTATION_TARGETS]),
  })
  .strict();

export type DryRunRotateArgs = z.infer<typeof dryRunRotateInputSchema>;

export const dryRunRotateTool = {
  name: "dry_run_rotate",
  description:
    "実 write はせず、どの provider に何が起きるかを返す。AI が確認 prompt を" +
    "組み立てる材料。side-effect 0 を保証する。",
  inputSchema: dryRunRotateInputSchema,
  execute: async (_env: Env, args: DryRunRotateArgs): Promise<RotateResult> => {
    const rotationId = newRotationId("rot");
    const results: RotateResult["results"] = {};
    for (const target of args.targets) {
      results[target] = { status: "skipped" };
    }
    return { ok: true, rotation_id: rotationId, dry_run: true, results };
  },
} as const;

async function runProvider(
  target: RotationTarget,
  args: ResolvedRotateArgs,
  env: Env,
  actorEmail: string | undefined,
): Promise<ProviderResult> {
  try {
    switch (target) {
      case "gcp": {
        const ctx = await gcpProxyCtxFromEnv(env, actorEmail);
        return await rotateGcp(
          {
            name: args.name,
            newValue: args.new_value,
            expectedVersionId: args.expected_gcp_version_id,
          },
          ctx,
        );
      }
      case "cf": {
        const ctx = await cfProxyCtxFromEnv(env, actorEmail);
        return await rotateCloudflare({ name: args.name, newValue: args.new_value }, ctx);
      }
      case "github": {
        const ctx = await ghProxyCtxFromEnv(env, actorEmail);
        return await rotateGithub({ name: args.name, newValue: args.new_value }, ctx);
      }
    }
  } catch (err) {
    // provider 関数は内部で throw しない契約だが、defense in depth として
    // 上位で握り潰す (= 1 provider の unexpected throw が他 provider を巻き
    // 込まないよう)。message は generic に。
    return {
      status: "fail",
      error: `${target} unexpected: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}

function newRotationId(prefix: string): string {
  return `${prefix}_${new Date().toISOString()}_${crypto.randomUUID().slice(0, 8)}`;
}
