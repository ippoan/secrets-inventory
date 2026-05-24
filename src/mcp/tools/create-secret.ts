import { z } from "zod";
import type { Env } from "../../types";
import { createGcp, gcpProxyCtxFromEnv } from "../../providers/gcp";
import { createCloudflare, cfProxyCtxFromEnv } from "../../providers/cloudflare";
import { createGithub, ghProxyCtxFromEnv } from "../../providers/github";

// Refs #45 Stage 2: `packages/rotate-mcp` の create_secret tool を親 worker
// に統合。3 system に新規 secret を作成 + 初版投入する。rotate_secret と
// 同じ scope (= mcp.write 必須)。

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const ROTATION_TARGETS = ["gcp", "cf", "github"] as const;
type RotationTarget = (typeof ROTATION_TARGETS)[number];

interface ProviderResult {
  status: "ok" | "fail";
  new_version?: string;
  secret_id?: string;
  created?: boolean;
  error?: string;
}

interface CreateResult {
  ok: boolean;
  rotation_id: string;
  dry_run: false;
  results: Partial<Record<RotationTarget, ProviderResult>>;
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
      .default([...ROTATION_TARGETS]),
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
  });

export type CreateSecretArgs = z.infer<typeof createSecretInputSchema>;

export const createSecretTool = {
  name: "create_secret",
  description:
    "3 system に新規 secret を作成し初版値を投入する。rotate_secret の create 版。" +
    "fail_if_exists=true (default) で既存衝突は fail。Refs #45 で Cloud Run proxy 経由に統一。",
  inputSchema: createSecretInputSchema,
  requiresScope: "mcp.write" as const,
  execute: async (env: Env, args: CreateSecretArgs, actorEmail?: string): Promise<CreateResult> => {
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
  },
} as const;

async function runCreate(
  target: RotationTarget,
  args: CreateSecretArgs,
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
