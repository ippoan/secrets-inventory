// Service Account 監査の 5 シグナル判定。pure function、test 容易。issue
// `secrets-inventory#20` の仕様に基づく。Recommender API ベースの「未使用 SA」
// は別 issue。

import type { ServiceAccount } from "../providers/gcp-iam";

export type SaFlag =
  | "no-role"
  | "disabled"
  | "key-old"
  | "default-sa"
  | "key-anomaly";

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
 * SA を 5 シグナルで監査し、flags + status + 年齢メタデータを返す。
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

  const status = deriveStatus(flags);
  return {
    flags,
    status,
    oldest_user_key_age_days: oldestAge,
    user_managed_key_count: userKeyCount,
  };
}

/**
 * status badge 判定。`no-role` または `disabled` は **削除候補** (🔴)。それ
 * 以外の flag は **warn** (🟡)。flag 0 なら **ok** (🟢)。
 */
export function deriveStatus(flags: SaFlag[]): SaStatus {
  if (flags.includes("no-role") || flags.includes("disabled")) {
    return "candidate";
  }
  if (flags.length > 0) {
    return "warn";
  }
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
