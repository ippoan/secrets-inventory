import type { InventoryResult } from "./inventory";
import type { ServiceTokenRow } from "./service-tokens";

/** secret 名の部分一致 (大文字小文字を区別しない)。正規表現ではなく単純な部分文字列。 */
export function nameMatches(name: string, filter: string): boolean {
  return name.toLowerCase().includes(filter.toLowerCase());
}

/** service token 行は token 名 (cf.name) か SM 台帳側の secret 名 (gcp.name) のどちらかが一致すれば残す。 */
export function serviceTokenRowMatches(
  row: ServiceTokenRow,
  filter: string,
): boolean {
  return (
    (row.cf !== null && nameMatches(row.cf.name, filter)) ||
    (row.gcp !== null && nameMatches(row.gcp.name, filter))
  );
}

export interface NameFilterInfo {
  /** 指定された絞り込み文字列 (そのままエコー)。 */
  name_filter: string;
  /** 絞り込み前の件数 (`rows` / `diff` / `service_tokens.rows`)。`provider_counts` は絞り込みに影響されない生件数。 */
  unfiltered_counts: {
    rows: number;
    diff_added: number;
    diff_removed: number;
    service_token_rows: number;
  };
}

/**
 * `gatherInventory` の結果を名前で絞り込む (snapshot 書き込みの後に呼ぶこと =
 * snapshot には絞る前の全件が書かれる)。`filter` が undefined なら入力をそのまま返し、
 * 返り値の形は 1 バイトも変わらない。指定時のみ `name_filter` / `unfiltered_counts` を足す。
 * 絞るのは `rows` / `diff.added|removed` / `service_tokens.rows`。
 */
export function applyNameFilter(
  inv: InventoryResult,
  filter: string | undefined,
): InventoryResult & Partial<NameFilterInfo> {
  if (filter === undefined) return inv;
  return {
    ...inv,
    rows: inv.rows.filter((r) => nameMatches(r.name, filter)),
    diff: {
      added: inv.diff.added.filter((n) => nameMatches(n, filter)),
      removed: inv.diff.removed.filter((n) => nameMatches(n, filter)),
    },
    service_tokens: {
      ...inv.service_tokens,
      rows: inv.service_tokens.rows.filter((r) =>
        serviceTokenRowMatches(r, filter),
      ),
    },
    name_filter: filter,
    unfiltered_counts: {
      rows: inv.rows.length,
      diff_added: inv.diff.added.length,
      diff_removed: inv.diff.removed.length,
      service_token_rows: inv.service_tokens.rows.length,
    },
  };
}
