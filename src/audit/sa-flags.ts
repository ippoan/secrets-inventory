// Service Account 監査の 5+2 シグナル判定。pure function、test 容易。issue
// `secrets-inventory#20` の original 5 シグナル + #29 で追加した `stale-auth`
// と `has-user-key`。Recommender API ベースの「未使用 SA」は別 issue。

import type { ServiceAccount } from "../providers/gcp-iam";

export type SaFlag =
  | "no-role"
  | "disabled"
  | "key-old"
  | "default-sa"
  | "key-anomaly"
  | "stale-auth"
  | "has-user-key";

export type SaStatus = "ok" | "warn" | "candidate";

export interface SaAudit {
  flags: SaFlag[];
  status: SaStatus;
  /** user-managed key の最古 valid_after からの経過日数。key 0 件なら null。 */
  oldest_user_key_age_days: number | null;
  /** user-managed key の数。 */
  user_managed_key_count: number;
}

/** key-old 判定の閾値。180 日 = 6 ヶ月 = rotation policy の上限想定。 */
export const KEY_OLD_THRESHOLD_DAYS = 180;
/** key-anomaly 判定の閾値。rotation 中 (= 旧 + 新) でも普通は 2 で済む。 */
export const KEY_ANOMALY_THRESHOLD = 3;
/**
 * stale-auth 判定の閾値。`last_authenticated_at` が確認できかつこの日数を
 * 超えていたら立つ。**`undefined` (= 観測無し / Policy Analyzer 集計遅延)** は
 * 立てない (= false positive 防止) — 新規 SA を即 stale 扱いしないため。
 */
export const STALE_AUTH_THRESHOLD_DAYS = 90;

/**
 * SA を監査し、flags + status + 年齢メタデータを返す。
 * `now` は test 用 override。本番は new Date()。
 */
export function auditServiceAccount(
  sa: ServiceAccount,
  now: Date = new Date(),
): SaAudit {
  const flags: SaFlag[] = [];

  if (sa.disabled) flags.push("disabled");
  if (sa.roles.length === 0) flags.push("no-role");
  if (isDefaultSa(sa.email)) flags.push("default-sa");

  const userKeys = sa.keys.filter((k) => k.key_type === "USER_MANAGED");
  const userKeyCount = userKeys.length;
  if (userKeyCount >= 1) flags.push("has-user-key");
  if (userKeyCount >= KEY_ANOMALY_THRESHOLD) flags.push("key-anomaly");

  let oldestAge: number | null = null;
  for (const k of userKeys) {
    if (!k.valid_after) continue;
    const ageMs = now.getTime() - new Date(k.valid_after).getTime();
    if (Number.isNaN(ageMs)) continue;
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
    if (oldestAge === null || ageDays > oldestAge) {
      oldestAge = ageDays;
    }
  }
  if (oldestAge !== null && oldestAge > KEY_OLD_THRESHOLD_DAYS) {
    flags.push("key-old");
  }

  if (isStaleAuth(sa, now)) flags.push("stale-auth");

  const status = deriveStatus(flags);
  return {
    flags,
    status,
    oldest_user_key_age_days: oldestAge,
    user_managed_key_count: userKeyCount,
  };
}

/**
 * `stale-auth` flag 判定。`undefined` (= 観測無し) は **flag を立てない**。
 * Policy Analyzer の集計遅延 (新規 SA や API 有効化直後の数時間〜) を candidate
 * 候補と誤判定しないためで、観測無しは UI 側で `"—"` として可視化される
 * (sa-ui.ts の `renderLastAuth`)。
 */
export function isStaleAuth(sa: ServiceAccount, now: Date): boolean {
  if (!sa.last_authenticated_at) return false;
  const ts = Date.parse(sa.last_authenticated_at);
  if (Number.isNaN(ts)) return false;
  const days = (now.getTime() - ts) / (1000 * 60 * 60 * 24);
  return days > STALE_AUTH_THRESHOLD_DAYS;
}

/**
 * status badge 判定。
 *
 * - `disabled` → candidate (既に無効化済 = 残骸候補)
 * - `no-role` + `stale-auth` → candidate (project IAM bind 無 + 90 日以上 idle
 *   = 真に dead な candidate)
 * - `no-role` のみ (= last_auth 最近 / 未観測) → **warn** に格下げ。これは #29
 *   の主目的: project IAM 外で binding されている (Cloud Run service-level
 *   invoker 等) SA を誤って削除候補にしないため。`stale-auth` が貯まれば改めて
 *   candidate に昇格する
 * - その他 flag (`default-sa` / `key-old` / `key-anomaly` / `has-user-key` /
 *   `stale-auth` 単独) → warn
 * - flag 0 → ok
 */
export function deriveStatus(flags: SaFlag[]): SaStatus {
  if (flags.includes("disabled")) return "candidate";
  if (flags.includes("no-role") && flags.includes("stale-auth")) {
    return "candidate";
  }
  if (flags.length > 0) return "warn";
  return "ok";
}

/**
 * GCE / App Engine の自動生成 default SA を判定する。これらは disable 推奨だが
 * 削除すると runtime が壊れる可能性があるため "warn" レベル扱い。
 */
export function isDefaultSa(email: string): boolean {
  return (
    /^[^@]+-compute@developer\.gserviceaccount\.com$/.test(email) ||
    /^[^@]+@appspot\.gserviceaccount\.com$/.test(email)
  );
}

export interface SaAuditSummary {
  total: number;
  ok: number;
  warn: number;
  candidate: number;
}

/** SA audit を集計して dashboard 上部の summary 用に counter を返す。 */
export function summarize(audits: Array<{ status: SaStatus }>): SaAuditSummary {
  let ok = 0;
  let warn = 0;
  let candidate = 0;
  for (const a of audits) {
    if (a.status === "ok") ok++;
    else if (a.status === "warn") warn++;
    else candidate++;
  }
  return { total: audits.length, ok, warn, candidate };
}
