import { z } from "zod";
import type { Env } from "../../types";
import { gatherInventory, type InventoryResult } from "../../inventory";
import { applyNameFilter, type NameFilterInfo } from "../../name-filter";

export const nameFilterSchema = z
  .string()
  .min(1)
  .max(128)
  .optional()
  .describe(
    "secret 名に含まれる文字列 (大文字小文字を区別しない部分一致)。指定すると、" +
      "名前が一致する行だけを返す",
  );

export const listInventoryInputSchema = z
  .object({
    commit_snapshot: z
      .boolean()
      .optional()
      .describe("true なら今回の GCP 名一覧を KV snapshot に書き戻す"),
    name_filter: nameFilterSchema,
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
    "記録漏れ) を含む (Refs #62)。`name_filter` (大文字小文字を区別しない部分一致、" +
    "正規表現ではない) を渡すと、名前が一致する `rows` / `diff.added|removed` / " +
    "`service_tokens.rows` (token 名か SM secret 名のどちらかが一致) だけを返す。" +
    "指定時のみ応答に `name_filter` と絞る前の件数 `unfiltered_counts` を足す " +
    "(`provider_counts` は絞り込みに影響されない生件数)。`commit_snapshot=true` と" +
    "併用しても snapshot には絞る前の全件が書かれる。",
  inputSchema: listInventoryInputSchema,
  execute: async (env: Env, args: ListInventoryArgs): Promise<InventoryResult & Partial<NameFilterInfo>> => {
    const inv = await gatherInventory(env, {
      commitSnapshot: args.commit_snapshot === true,
    });
    return applyNameFilter(inv, args.name_filter);
  },
} as const;
