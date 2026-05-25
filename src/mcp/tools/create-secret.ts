import { z } from "zod";
import type { Env } from "../../types";
import { createGcp, gcpProxyCtxFromEnv } from "../../providers/gcp";
import { createCloudflare, cfProxyCtxFromEnv } from "../../providers/cloudflare";
import { createGithub, ghProxyCtxFromEnv } from "../../providers/github";

// Refs #45 Stage 2: `packages/rotate-mcp` の create_secret tool を親 worker
// に統合。3 system に新規 secret を作成 + 初版投入する。rotate_secret と
// 同じ scope (= mcp.write 必須)。
//
// HTTP body 経由で value を受け取る `PUT /mcp/secret-upload/:name` route
// (`src/routes/secret-upload.ts`) も同じ `executeCreate` を共有する。LLM
// agent が tool-call の JSON parameter に value を載せず、shell の curl で
// `--data-binary @file` を流せる経路 (= LLM context に value を載せない) を
// 提供するため。

export const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
export const ROTATION_TARGETS = ["gcp", "cf", "github"] as const;
export type RotationTarget = (typeof ROTATION_TARGETS)[number];

/**
 * `targets` から `"gcp"` を外せないようにする policy。GCP Secret Manager を
 * source of truth として運用する規約 (repo CLAUDE.md) を破ると inventory /
 * snapshot / drift 検出が機能しなくなる (= GH/CF にだけ存在する "orphan"
 * secret が出る) ため、create / rotate / HTTP upload の全 entry で同じ
 * check を共有する。
 */
export const TARGETS_MUST_INCLUDE_GCP_MESSAGE =
  "targets must include 'gcp' (GCP is the source of truth; CF/GitHub-only " +
  "is forbidden because inventory drift detection breaks without a GCP anchor)";

export function targetsIncludeGcp(targets: readonly string[]): boolean {
  return targets.includes("gcp");
}

export interface ProviderResult {
  status: "ok" | "fail";
  new_version?: string;
  secret_id?: string;
  created?: boolean;
  error?: string;
}

export interface CreateResult {
  ok: boolean;
  rotation_id: string;
  dry_run: false;
  results: Partial<Record<RotationTarget, ProviderResult>>;
}

/** `initial_value` を持つ最終形の create_secret 引数。MCP tool / HTTP route
 *  の両 entry point から `executeCreate` に流す。 */
export interface ResolvedCreateArgs {
  name: string;
  initial_value: string;
  targets: readonly RotationTarget[];
  fail_if_exists: boolean;
  cf_scopes?: string[];
}

export async function executeCreate(
  env: Env,
  args: ResolvedCreateArgs,
  actorEmail?: string,
): Promise<CreateResult> {
  const rotationId = `crt_${new Date().toISOString()}_${crypto.randomUUID().slice(0, 8)}`;
  const pending: Array<Promise<[RotationTarget, ProviderResult]>> = [];
  for (const target of args.targets) {
    pending.push(runCreate(target, args, env, actorEmail).then((r) => [target, r]));
  }
  const settled = await Promise.all(pending);
  const results: CreateResult["results"] = {};
  let ok = true;
  for (const [target, result] of settled) {
    results[target] = result;
    if (result.status !== "ok") ok = false;
  }
  return { ok, rotation_id: rotationId, dry_run: false, results };
}

export const createSecretInputSchema = z
  .object({
    name: z
      .string()
      .regex(NAME_PATTERN, "name must match ^[A-Za-z][A-Za-z0-9_-]{0,127}$"),
    initial_value: z
      .string()
      .min(1)
      .max(65536)
      .describe("初版値。response / log に echo されない。"),
    targets: z
      .array(z.enum(ROTATION_TARGETS))
      .min(1)
      .default([...ROTATION_TARGETS])
      .describe(
        "更新対象 provider 群。省略時は 3 system すべて。" +
          "GCP は source of truth として必ず含めること (= `gcp` を外せない)。",
      ),
    confirm_name: z.string(),
    fail_if_exists: z
      .boolean()
      .default(true)
      .describe("true (default) で既存衝突は fail。false で既存 secret 再利用 (新 version 投入)。"),
    cf_scopes: z
      .array(z.string())
      .optional()
      .describe('CF Secrets Store scopes (default = ["workers"])。CF target のみ意味あり。'),
  })
  .strict()
  .refine((d) => d.confirm_name === d.name, {
    message: "confirm_name does not match name",
    path: ["confirm_name"],
  })
  .refine((d) => targetsIncludeGcp(d.targets), {
    message: TARGETS_MUST_INCLUDE_GCP_MESSAGE,
    path: ["targets"],
  });

export type CreateSecretArgs = z.infer<typeof createSecretInputSchema>;

export const createSecretTool = {
  name: "create_secret",
  description:
    "3 system に新規 secret を作成し初版値を投入する。rotate_secret の create 版。" +
    "fail_if_exists=true (default) で既存衝突は fail。Refs #45 で Cloud Run proxy 経由に統一。" +
    "LLM agent の tool-call JSON に value を載せたくない場合は HTTP route " +
    "`PUT /mcp/secret-upload/:name?targets=...` に curl --data-binary で直接流せる " +
    "(value は LLM context を経由せず、shell → curl body → worker memory → " +
    "Secret Manager の経路で投入される)。",
  inputSchema: createSecretInputSchema,
  requiresScope: "mcp.write" as const,
  execute: async (env: Env, args: CreateSecretArgs, actorEmail?: string): Promise<CreateResult> => {
    return await executeCreate(
      env,
      {
        name: args.name,
        initial_value: args.initial_value,
        targets: args.targets,
        fail_if_exists: args.fail_if_exists,
        cf_scopes: args.cf_scopes,
      },
      actorEmail,
    );
  },
} as const;

async function runCreate(
  target: RotationTarget,
  args: ResolvedCreateArgs,
  env: Env,
  actorEmail: string | undefined,
): Promise<ProviderResult> {
  try {
    switch (target) {
      case "gcp": {
        const ctx = await gcpProxyCtxFromEnv(env, actorEmail);
        return await createGcp(
          {
            name: args.name,
            initialValue: args.initial_value,
            failIfExists: args.fail_if_exists,
          },
          ctx,
        );
      }
      case "cf": {
        const ctx = await cfProxyCtxFromEnv(env, actorEmail);
        return await createCloudflare(
          {
            name: args.name,
            initialValue: args.initial_value,
            failIfExists: args.fail_if_exists,
            scopes: args.cf_scopes,
          },
          ctx,
        );
      }
      case "github": {
        const ctx = await ghProxyCtxFromEnv(env, actorEmail);
        return await createGithub(
          {
            name: args.name,
            initialValue: args.initial_value,
            failIfExists: args.fail_if_exists,
          },
          ctx,
        );
      }
    }
  } catch (err) {
    return {
      status: "fail",
      error: `${target} unexpected: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}
