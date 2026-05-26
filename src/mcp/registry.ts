/**
 * MCP tool registry.
 *
 * `src/mcp/server.ts` と `src/mcp/tools/read-first.ts` の両方が同じ list を
 * 参照できるように **registry を 1 ファイルに切り出した** (= single source of
 * truth)。tool を追加する時は本ファイルの `STATIC_TOOLS` に 1 行加えるだけで
 * `tools/list` (server) と `read_first` の動的列挙の両方に自動反映される。
 *
 * read_first 自身は循環依存を避けるため registry に含めない。server.ts 側で
 * `[readFirstTool, ...STATIC_TOOLS]` と prepend する。
 */
import type { z } from "zod";
import type { Env } from "../types";
import { listInventoryTool } from "./tools/list-inventory";
import { listServiceAccountsTool } from "./tools/list-service-accounts";
import { getDriftTool } from "./tools/get-drift";
import { getSnapshotTool } from "./tools/get-snapshot";
import { rotateSecretTool, dryRunRotateTool } from "./tools/rotate-secret";
import { createSecretTool } from "./tools/create-secret";

export interface ToolEntry<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  requiresScope?: string;
  execute: (env: Env, args: z.infer<S>, actorEmail?: string) => Promise<unknown>;
}

/**
 * 既存 MCP tool 群。`read_first` 以外の全 tool。
 *
 * 追加方法:
 *   1. `src/mcp/tools/<name>.ts` を作って `xxxTool` を export
 *   2. ここに import + STATIC_TOOLS に push
 *   それだけで `tools/list` + `read_first` の両方に出る。
 */
export const STATIC_TOOLS: ToolEntry<z.ZodTypeAny>[] = [
  listInventoryTool as unknown as ToolEntry<z.ZodTypeAny>,
  listServiceAccountsTool as unknown as ToolEntry<z.ZodTypeAny>,
  getDriftTool as unknown as ToolEntry<z.ZodTypeAny>,
  getSnapshotTool as unknown as ToolEntry<z.ZodTypeAny>,
  // write tools (Refs #45 Stage 2): packages/rotate-mcp から移植。
  // requiresScope: "mcp.write" で binding_jwt scope check が走る。
  rotateSecretTool as unknown as ToolEntry<z.ZodTypeAny>,
  dryRunRotateTool as unknown as ToolEntry<z.ZodTypeAny>,
  createSecretTool as unknown as ToolEntry<z.ZodTypeAny>,
];
