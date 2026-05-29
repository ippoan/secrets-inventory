import { z } from "zod";
import type { Env } from "../../types";
import { gatherInventory, type InventoryResult } from "../../inventory";
import type { InventoryRow } from "../../diff";
import type { ServiceTokenRow } from "../../service-tokens";

export const DRIFT_TARGETS = ["github", "cloudflare", "service_tokens"] as const;
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
    reason: z
      .string()
      .max(200)
      .optional()
      .describe(
        "任意の監査用メモ。指定すると応答 (`reason`) にそのままエコーされる " +
          "(なぜ drift チェックを走らせたかの文脈を audit に残す用途)。値の" +
          "検査・副作用は無い。",
      ),
  })
  .strict();

export type GetDriftArgs = z.infer<typeof getDriftInputSchema>;

export interface GetDriftResult {
  gcp_project_id: string;
  targets: DriftTarget[];
  rows: InventoryRow[];
  /**
   * `service_tokens` target が drift している行 (= status !== "ok")。
   * orphan (野良) / missing_in_cf (記録漏れ) のみ。target に含まれない時は空。
   * Refs #62.
   */
  service_token_rows: ServiceTokenRow[];
  errors: InventoryResult["errors"];
  provider_counts: InventoryResult["provider_counts"];
  /** 入力 `reason` をそのままエコー (指定時のみ)。audit 文脈の保持用。 */
  reason?: string;
}

export const getDriftTool = {
  name: "get_drift",
  description:
    "GCP を基準として、指定 provider に同名 secret が存在しない (= drift して" +
    "いる) 行のみ返す。`targets` 省略時は github / cloudflare / service_tokens " +
    "すべてを対象。値は返さずメタデータのみ。provider fetch 失敗 (= in_x が " +
    "null) の行は drift 扱いにせず除外する (= 「不明」を「あり」「無し」の" +
    "どちらにも倒さない)。`service_tokens` は CF Access service token を GCP " +
    "SM の cf_token_id ラベル台帳と突合し、orphan (野良) / missing_in_cf " +
    "(記録漏れ) を `service_token_rows` に返す。",
  inputSchema: getDriftInputSchema,
  execute: async (env: Env, args: GetDriftArgs): Promise<GetDriftResult> => {
    const targets = (args.targets ?? DRIFT_TARGETS) as DriftTarget[];
    const inv = await gatherInventory(env);
    const rows = inv.rows.filter((r) => isDrifted(r, targets));
    const service_token_rows = targets.includes("service_tokens")
      ? inv.service_tokens.rows.filter((r) => r.status !== "ok")
      : [];
    return {
      gcp_project_id: inv.gcp_project_id,
      targets,
      rows,
      service_token_rows,
      errors: inv.errors,
      provider_counts: inv.provider_counts,
      ...(args.reason ? { reason: args.reason } : {}),
    };
  },
} as const;

function isDrifted(row: InventoryRow, targets: DriftTarget[]): boolean {
  if (targets.includes("github") && row.in_github === false) return true;
  if (targets.includes("cloudflare") && row.in_cloudflare === false) return true;
  return false;
}
