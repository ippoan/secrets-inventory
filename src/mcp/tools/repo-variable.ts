import { z } from "zod";
import type { Env } from "../../types";
import {
  setGitHubRepoVariable,
  listGitHubRepoVariables,
  ghProxyCtxFromEnv,
} from "../../providers/github";

// GitHub Actions **repo variables** (平文 config 値、secret ではない) を扱う
// MCP tool 2 種。`secrets-inventory-gcp` proxy の `/gh/variables` を consume する。
//
// secret (create_secret / rotate_secret) と違い value は平文 config なので、
// tool-call JSON parameter に value を載せてよい (= context leak の懸念対象外)。
// 秘匿値は **必ず create_secret / rotate_secret** を使うこと。
//
// 用途例: CI deploy gate の repo variable `STAGING_DEPLOY_ENABLED=true` を、
// GitHub Settings UI を手で触らず MCP から設定する。

const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const VAR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

export const setRepoVariableInputSchema = z
  .object({
    repo: z.string().regex(REPO_PATTERN, "repo must be owner/name"),
    name: z
      .string()
      .regex(VAR_NAME_PATTERN, "name must match ^[A-Za-z][A-Za-z0-9_-]{0,127}$"),
    value: z
      .string()
      .min(1)
      .max(65536)
      .describe("variable の平文値 (secret ではない config 値)。秘匿値は create_secret を使う。"),
  })
  .strict();

export type SetRepoVariableArgs = z.infer<typeof setRepoVariableInputSchema>;

export const setRepoVariableTool = {
  name: "set_repo_variable",
  description:
    "GitHub Actions の repo variable (平文 config 値、secret ではない) を upsert する。" +
    "例: CI deploy gate の STAGING_DEPLOY_ENABLED=true。無ければ create、有れば update " +
    "(response の created で識別)。秘匿値は本 tool ではなく create_secret / rotate_secret を使うこと。",
  inputSchema: setRepoVariableInputSchema,
  requiresScope: "mcp.write" as const,
  execute: async (env: Env, args: SetRepoVariableArgs, actorEmail?: string) => {
    const ctx = await ghProxyCtxFromEnv(env, actorEmail);
    return await setGitHubRepoVariable(
      { repo: args.repo, name: args.name, value: args.value },
      ctx,
    );
  },
} as const;

export const listRepoVariablesInputSchema = z
  .object({
    repo: z.string().regex(REPO_PATTERN, "repo must be owner/name"),
  })
  .strict();

export type ListRepoVariablesArgs = z.infer<typeof listRepoVariablesInputSchema>;

export const listRepoVariablesTool = {
  name: "list_repo_variables",
  description:
    "GitHub Actions の repo variable 一覧 (name + value、平文 config) を返す。" +
    "secret ではないので value も返る (= 隠さない)。",
  inputSchema: listRepoVariablesInputSchema,
  execute: async (env: Env, args: ListRepoVariablesArgs, actorEmail?: string) => {
    const ctx = await ghProxyCtxFromEnv(env, actorEmail);
    const variables = await listGitHubRepoVariables(args.repo, ctx);
    return { variables };
  },
} as const;
