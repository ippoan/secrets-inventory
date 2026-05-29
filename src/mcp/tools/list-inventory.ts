import { z } from "zod";
import type { Env } from "../../types";
import { gatherInventory, type InventoryResult } from "../../inventory";

export const listInventoryInputSchema = z
  .object({
    commit_snapshot: z
      .boolean()
      .optional()
      .describe("true なら今回の GCP 名一覧を KV snapshot に書き戻す"),
  })
  .strict();

export type ListInventoryArgs = z.infer<typeof listInventoryInputSchema>;

export const listInventoryTool = {
  name: "list_inventory",
  description:
    "GCP / Cloudflare / GitHub の 3 system から secret 名一覧を取得し、GCP を" +
    "基準に突合した結果を返す。値は含まずメタデータのみ。`commit_snapshot=true` " +
    "を渡すと今回の GCP 名一覧を KV snapshot として上書きする。返り値の " +
    "`service_tokens.rows` には CF Access service token を GCP SM の " +
    "cf_token_id ラベル台帳と突合した結果 (ok / orphan=野良 / missing_in_cf=" +
    "記録漏れ) を含む (Refs #62)。",
  inputSchema: listInventoryInputSchema,
  execute: async (env: Env, args: ListInventoryArgs): Promise<InventoryResult> => {
    return await gatherInventory(env, {
      commitSnapshot: args.commit_snapshot === true,
    });
  },
} as const;
