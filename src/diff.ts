import type { SecretMetadata } from "./types";

/**
 * GCP の各 secret 名 1 行 = 配布先 (GitHub / Cloudflare) の有無 + 前回 snapshot
 * からの新規フラグ。
 *
 * `in_github` / `in_cloudflare` が `null` の場合は「該当プロバイダーの取得が
 * 失敗したので不明」を表す (partial-success 表示用)。`false` は「取れたが
 * 同名が存在しなかった」=反映漏れの可能性。
 *
 * `github` / `cloudflare` フィールドは、同名 secret のメタデータ
 * (created_at / updated_at / extra) を tooltip 等で出すための実体。
 * `null` = 未マッチ or provider 失敗。
 */
export interface InventoryRow {
  name: string;
  gcp: SecretMetadata;
  in_github: boolean | null;
  in_cloudflare: boolean | null;
  github: SecretMetadata | null;
  cloudflare: SecretMetadata | null;
  is_new_since_snapshot: boolean;
}

/**
 * 前回 snapshot との差分。snapshot が一度も無い場合は両方 `[]`
 * (= 「初回キャプチャ前なので何が新しいか分からない」明示)。
 */
export interface InventoryDiff {
  added: string[];
  removed: string[];
}

export interface InventoryInputs {
  gcp: SecretMetadata[];
  github: SecretMetadata[] | null;
  cloudflare: SecretMetadata[] | null;
  /** `null` = 前回 snapshot が KV に無い (初回)。`[]` = 前回 snapshot が空配列。 */
  previousGcpNames: string[] | null;
}

export function buildInventory(input: InventoryInputs): {
  rows: InventoryRow[];
  diff: InventoryDiff;
} {
  const ghByName =
    input.github === null
      ? null
      : new Map(input.github.map((s) => [s.name, s]));
  const cfByName =
    input.cloudflare === null
      ? null
      : new Map(input.cloudflare.map((s) => [s.name, s]));

  const hasPrevious = input.previousGcpNames !== null;
  const previousSet = new Set(input.previousGcpNames ?? []);
  const currentSet = new Set(input.gcp.map((s) => s.name));

  const rows: InventoryRow[] = input.gcp
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({
      name: s.name,
      gcp: s,
      in_github: ghByName === null ? null : ghByName.has(s.name),
      in_cloudflare: cfByName === null ? null : cfByName.has(s.name),
      github: ghByName?.get(s.name) ?? null,
      cloudflare: cfByName?.get(s.name) ?? null,
      is_new_since_snapshot: hasPrevious && !previousSet.has(s.name),
    }));

  const added = hasPrevious
    ? [...currentSet].filter((n) => !previousSet.has(n)).sort()
    : [];
  const removed = hasPrevious
    ? [...previousSet].filter((n) => !currentSet.has(n)).sort()
    : [];

  return { rows, diff: { added, removed } };
}
