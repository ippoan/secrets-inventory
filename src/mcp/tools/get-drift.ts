import { z } from "zod";
import type { Env } from "../../types";
import { gatherInventory, type InventoryResult } from "../../inventory";
import type { InventoryRow } from "../../diff";

export const DRIFT_TARGETS = ["github", "cloudflare"] as const;
export type DriftTarget = (typeof DRIFT_TARGETS)[number];

export const getDriftInputSchema = z
  .object({
    targets: z
      .array(z.enum(DRIFT_TARGETS))
      .min(1)
      .optional()
      .describe(
        "drift をチェックする provider 群。省略時は github / cloudflare 両方。",
      ),
  })
  .strict();

export type GetDriftArgs = z.infer<typeof getDriftInputSchema>;

export interface GetDriftResult {
  gcp_project_id: string;
  targets: DriftTarget[];
  rows: InventoryRow[];
  errors: InventoryResult["errors"];
  provider_counts: InventoryResult["provider_counts"];
}

export const getDriftTool = {
  name: "get_drift",
  description:
    "GCP を基準として、指定 provider に同名 secret が存在しない (= drift して" +
    "いる) 行のみ返す。`targets` 省略時は github / cloudflare 両方を対象。" +
    "値は返さずメタデータのみ。provider fetch 失敗 (= in_x が null) の行は drift " +
    "扱いにせず除外する (= 「不明」を「あり」「無し」のどちらにも倒さない)。",
  inputSchema: getDriftInputSchema,
  execute: async (env: Env, args: GetDriftArgs): Promise<GetDriftResult> => {
    const targets = (args.targets ?? DRIFT_TARGETS) as DriftTarget[];
    const inv = await gatherInventory(env);
    const rows = inv.rows.filter((r) => isDrifted(r, targets));
    return {
      gcp_project_id: inv.gcp_project_id,
      targets,
      rows,
      errors: inv.errors,
      provider_counts: inv.provider_counts,
    };
  },
} as const;

function isDrifted(row: InventoryRow, targets: DriftTarget[]): boolean {
  if (targets.includes("github") && row.in_github === false) return true;
  if (targets.includes("cloudflare") && row.in_cloudflare === false) return true;
  return false;
}
