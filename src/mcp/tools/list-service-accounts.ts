import { z } from "zod";
import type { Env } from "../../types";
import {
  gatherSaInventory,
  GcpIamUnavailableError,
  type SaInventoryResult,
} from "../../sa-inventory";

export const listServiceAccountsInputSchema = z.object({}).strict();

export type ListServiceAccountsArgs = z.infer<
  typeof listServiceAccountsInputSchema
>;

export const listServiceAccountsTool = {
  name: "list_service_accounts",
  description:
    "GCP service accounts の inventory + 5-signal 監査結果 (key 古い / role 過剰 / " +
    "user-managed key 有無 / 未認証期間 / 役割なし) を返す。dashboard の " +
    "/service-accounts と同じ payload。",
  inputSchema: listServiceAccountsInputSchema,
  execute: async (
    env: Env,
    _args: ListServiceAccountsArgs,
  ): Promise<SaInventoryResult> => {
    return await gatherSaInventory(env);
  },
} as const;

export { GcpIamUnavailableError };
