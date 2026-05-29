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
import { syncFromGcpTool } from "./tools/sync-from-gcp";
import { convertPkcs8Tool } from "./tools/convert-pkcs8";
import {
  rotateServiceTokenTool,
  deleteServiceTokenTool,
} from "./tools/service-token-write";

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
  // sync_from_gcp (Refs #57): GCP に既にある値を CF / GitHub にコピーする。
  // value parameter を持たないので tool-call JSON 経由の context leak は
  // 構造的にゼロ。既存 HTTP route `POST /mcp/sync-from-gcp/:name` を MCP
  // tool として expose することで `tools/list` から発見可能にする。
  syncFromGcpTool as unknown as ToolEntry<z.ZodTypeAny>,
  // convert_secret_pkcs8 (Refs #59): GCP の PKCS#1 RSA 秘密鍵を PKCS#8 に変換し
  // 別名で保存 + 任意で GitHub propagate。create-github-app-token@v2 の
  // "Invalid keyData" 対策。値は proxy 内完結で context に載らない。
  convertPkcs8Tool as unknown as ToolEntry<z.ZodTypeAny>,
  // Phase 2 (Refs #64): CF Access Service Token の rotate / delete。
  // requiresScope: "mcp.write" + type-to-confirm + protected-id ガード付き。
  // rotate の新 client_secret は proxy→SM 直書きで context に載らない。
  rotateServiceTokenTool as unknown as ToolEntry<z.ZodTypeAny>,
  deleteServiceTokenTool as unknown as ToolEntry<z.ZodTypeAny>,
];
