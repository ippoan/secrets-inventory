import { z } from "zod";
import type { Env } from "../../types";
import { readSnapshot, type SnapshotV1 } from "../../snapshot";

export const getSnapshotInputSchema = z.object({}).strict();

export type GetSnapshotArgs = z.infer<typeof getSnapshotInputSchema>;

export const getSnapshotTool = {
  name: "get_snapshot",
  description:
    "KV に保管されている前回 GCP secret 名一覧 snapshot を返す。" +
    "未保存 (= 初回キャプチャ前) なら null。`list_inventory` の diff (added/removed) " +
    "計算に使われているのと同じデータ。",
  inputSchema: getSnapshotInputSchema,
  execute: async (
    env: Env,
    _args: GetSnapshotArgs,
  ): Promise<SnapshotV1 | null> => {
    return await readSnapshot(env.SNAPSHOT_KV);
  },
} as const;
