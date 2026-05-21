/**
 * 前回の GCP secret 名一覧 snapshot を KV に保持する薄いラッパー。
 *
 * 名前だけを保存する (値も labels も含まない)。snapshot の目的は「GCP 側で
 * 名前が増えた／消えたか」の差分検知のみ。
 */

const KEY = "snapshot:gcp:latest";

export interface SnapshotV1 {
  v: 1;
  captured_at: string;
  names: string[];
}

/** KV から snapshot を読む。未保存 / 壊れた形なら `null`。 */
export async function readSnapshot(
  kv: KVNamespace,
): Promise<SnapshotV1 | null> {
  const raw = await kv.get(KEY, "json");
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Partial<SnapshotV1>;
  if (obj.v !== 1) return null;
  if (!Array.isArray(obj.names)) return null;
  return {
    v: 1,
    captured_at: typeof obj.captured_at === "string" ? obj.captured_at : "",
    names: obj.names.filter((n): n is string => typeof n === "string"),
  };
}

/** 新しい snapshot を書き、書いた snapshot を返す。 */
export async function writeSnapshot(
  kv: KVNamespace,
  names: string[],
  now: () => Date = () => new Date(),
): Promise<SnapshotV1> {
  const snapshot: SnapshotV1 = {
    v: 1,
    captured_at: now().toISOString(),
    names: [...names].sort(),
  };
  await kv.put(KEY, JSON.stringify(snapshot));
  return snapshot;
}

/** `readSnapshot` で参照する KV キー。テスト用に export。 */
export const SNAPSHOT_KEY = KEY;
