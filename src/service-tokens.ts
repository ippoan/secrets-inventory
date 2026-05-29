import type { SecretMetadata } from "./types";

/**
 * CF Access Service Token の横断棚卸し (Refs #62)。
 *
 * 既存の secret 突合 (`diff.ts` の `buildInventory`) は **GCP secret 名を軸**に
 * GitHub / Cloudflare の同名有無を見る。Service Token はこのモデルに乗らない:
 *
 * - 突合キーが name ではなく、GCP SM secret (= client_secret 保管先) に貼った
 *   ラベル `cf_token_id` ↔ CF service token の `id`
 * - 「野良 (orphan)」= CF に在るが SM 台帳に無い token は **対応する GCP row が
 *   そもそも存在しない**ので、GCP-centric な row には載せられない
 *
 * そこで secret inventory とは **別配列**として reconcile する。既存の
 * `InventoryRow` / `diff` / snapshot ロジックには一切触れない。
 */

/** GCP SM secret に貼る、対応する CF service token id を指すラベルキー。 */
export const CF_TOKEN_ID_LABEL = "cf_token_id";

export type ServiceTokenStatus = "ok" | "orphan" | "missing_in_cf";

export interface ServiceTokenRow {
  /**
   * - `ok`            = CF token と GCP SM 台帳 (cf_token_id ラベル) が突合できた
   * - `orphan`        = CF に在るが SM 台帳に無い (= **野良** service token)
   * - `missing_in_cf` = SM 台帳 (cf_token_id ラベル付き) に在るが CF に無い
   *                     (= **記録漏れ** / 失効後の台帳掃除漏れ)
   */
  status: ServiceTokenStatus;
  /** 突合キー = CF token の `id` (SM ラベル `cf_token_id` と照合)。 */
  cf_token_id: string | null;
  /** CF Access service token メタデータ。`missing_in_cf` では `null`。 */
  cf: SecretMetadata | null;
  /** 対応する GCP SM secret (client_secret 保管) メタデータ。`orphan` では `null`。 */
  gcp: SecretMetadata | null;
}

export interface ReconcileServiceTokensInput {
  /** CF Access service token list。`null` = fetch 失敗 (= 突合不能)。 */
  cfServiceTokens: SecretMetadata[] | null;
  /** GCP SM secret 全件。`extra.labels` に `cf_token_id` を持ちうる。 */
  gcpSecrets: SecretMetadata[];
}

export interface ServiceTokenReconciliation {
  rows: ServiceTokenRow[];
}

/**
 * CF service token と GCP SM 台帳 (cf_token_id ラベル) を突合する。
 *
 * CF fetch 失敗時 (`cfServiceTokens === null`) は突合不能なので空 rows を返す。
 * これは「不明」を「野良」「記録漏れ」のどちらにも倒さないための明示的 early
 * return (= partial-success 時に誤検出しない)。呼び出し元は別途 errors を見る。
 */
export function reconcileServiceTokens(
  input: ReconcileServiceTokensInput,
): ServiceTokenReconciliation {
  if (input.cfServiceTokens === null) {
    return { rows: [] };
  }

  // GCP SM 台帳: cf_token_id ラベル値 → secret。
  const gcpByTokenId = new Map<string, SecretMetadata>();
  for (const s of input.gcpSecrets) {
    const tokenId = extractCfTokenIdLabel(s);
    if (tokenId) gcpByTokenId.set(tokenId, s);
  }

  const matchedTokenIds = new Set<string>();
  const rows: ServiceTokenRow[] = [];

  for (const t of input.cfServiceTokens) {
    const id = t.id ?? null;
    const gcp = id ? gcpByTokenId.get(id) ?? null : null;
    if (gcp && id) matchedTokenIds.add(id);
    rows.push({
      status: gcp ? "ok" : "orphan",
      cf_token_id: id,
      cf: t,
      gcp,
    });
  }

  // SM 台帳に cf_token_id があるが CF 側に対応 token が無い → 記録漏れ。
  for (const [tokenId, gcp] of gcpByTokenId) {
    if (matchedTokenIds.has(tokenId)) continue;
    rows.push({
      status: "missing_in_cf",
      cf_token_id: tokenId,
      cf: null,
      gcp,
    });
  }

  // 安定 sort: 要対応 (orphan → missing_in_cf) を上に、その中で name 昇順。
  rows.sort((a, b) => {
    const sa = statusRank(a.status);
    const sb = statusRank(b.status);
    if (sa !== sb) return sa - sb;
    return rowName(a).localeCompare(rowName(b));
  });

  return { rows };
}

function rowName(row: ServiceTokenRow): string {
  return row.cf?.name ?? row.gcp?.name ?? "";
}

function statusRank(s: ServiceTokenStatus): number {
  switch (s) {
    case "orphan":
      return 0;
    case "missing_in_cf":
      return 1;
    case "ok":
      return 2;
  }
}

/** GCP secret の `extra.labels[cf_token_id]` を取り出す。無ければ `null`。 */
function extractCfTokenIdLabel(meta: SecretMetadata): string | null {
  const labels = meta.extra?.labels;
  if (labels && typeof labels === "object" && !Array.isArray(labels)) {
    const v = (labels as Record<string, unknown>)[CF_TOKEN_ID_LABEL];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}
