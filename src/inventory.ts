import type { Env, SecretMetadata } from "./types";
import {
  listCloudflareSecrets,
  listCloudflareServiceTokens,
} from "./providers/cloudflare";
import { listGitHubOrgSecrets } from "./providers/github";
import { listGcpSecrets } from "./providers/gcp";
import { buildInventory, type InventoryRow, type InventoryDiff } from "./diff";
import {
  reconcileServiceTokens,
  type ServiceTokenReconciliation,
} from "./service-tokens";
import { readSnapshot, writeSnapshot } from "./snapshot";

export interface GatherOptions {
  /** true なら今回の GCP 名一覧を snapshot として KV に書き戻す。 */
  commitSnapshot?: boolean;
}

export interface InventoryResult {
  gcp_project_id: string;
  rows: InventoryRow[];
  diff: InventoryDiff;
  previous_snapshot_at: string | null;
  snapshot_at: string | null;
  snapshot_committed: boolean;
  /** github / cloudflare / service_tokens が落ちた時のメッセージ。GCP が落ちると throw。 */
  errors: { github?: string; cloudflare?: string; service_tokens?: string };
  /**
   * 各 provider の取得件数。`null` は fetch 失敗 (errors に reason 入り)。
   * 「赤バナーが出ていないだけで、何件取れたか分からない」を UI 側で
   * 解消するために生件数を持っておく。`service_tokens` は CF Access の
   * service token list 取得数 (Refs #62)。
   */
  provider_counts: {
    gcp: number;
    github: number | null;
    cloudflare: number | null;
    service_tokens: number | null;
  };
  /**
   * CF Access Service Token の横断棚卸し結果 (Refs #62)。既存の
   * GCP-centric な `rows` とは独立した別配列。CF token を GCP SM の
   * `cf_token_id` ラベル台帳と突合し、orphan (野良) / missing_in_cf
   * (記録漏れ) / ok を判定する。
   */
  service_tokens: ServiceTokenReconciliation;
}

/**
 * GCP は source of truth なので fetch 失敗 = inventory 全体が成立しない。
 * 呼び出し元はこの例外を 502 等に翻訳する。
 */
export class GcpUnavailableError extends Error {
  constructor(reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = "GcpUnavailableError";
  }
}

/**
 * 3 プロバイダーから現時点の secrets を取り、GCP を基準に突合し、KV の前回
 * snapshot との diff を返す。
 *
 * 各 provider の処理は **token 取得 + list 呼び出しをまとめて 1 つの promise**
 * にして `Promise.allSettled` で並列化する。これによって:
 *
 * - Secrets Store の `.get()` が "Secrets Worker: Failed to fetch secret" で
 *   throw しても、その provider だけが reject して errors に乗る (旧実装は
 *   `Promise.all` で token 取得をまとめていたので 1 つでも throw すると全体が
 *   落ちて Internal Server Error になっていた)
 * - 同じ provider の token 取得失敗 / list API 失敗を区別せずに reason を
 *   surface できる (どちらも操作者目線では「この provider が引けない」)
 *
 * GitHub / CF の partial-success 扱いは継続。GCP (source of truth) だけは
 * GcpUnavailableError を throw して呼び出し元が 502 を返せるようにする。
 */
export async function gatherInventory(
  env: Env,
  opts: GatherOptions = {},
): Promise<InventoryResult> {
  // Refs #45: 3 provider すべて GCP proxy 経由に統一されたため、worker が持つ
  // secret は `GCP_PROXY_API_KEY` 1 個だけ。1 度 fetch して 3 provider 並列
  // 呼び出しで共有する。`.get()` 自体が throw した場合は GCP source of truth
  // にも到達できないため GcpUnavailableError として扱う (= 旧 CF/GH 個別
  // throw 経路は #45 で消滅)。
  const proxyUrl = env.GCP_PROXY_URL;
  let apiKey: string;
  try {
    apiKey = await env.GCP_PROXY_API_KEY.get();
  } catch (err) {
    throw new GcpUnavailableError(err);
  }

  const [gcpSettled, ghSettled, cfSettled, cfStSettled] =
    await Promise.allSettled([
      listGcpSecrets({ proxyUrl, apiKey }),
      listGitHubOrgSecrets({ proxyUrl, apiKey }),
      listCloudflareSecrets({ proxyUrl, apiKey }),
      listCloudflareServiceTokens({ proxyUrl, apiKey }),
    ]);

  if (gcpSettled.status === "rejected") {
    throw new GcpUnavailableError(gcpSettled.reason);
  }
  const gcp = gcpSettled.value;

  const errors: {
    github?: string;
    cloudflare?: string;
    service_tokens?: string;
  } = {};
  const github: SecretMetadata[] | null =
    ghSettled.status === "fulfilled" ? ghSettled.value : null;
  if (ghSettled.status === "rejected") {
    errors.github = reasonMessage(ghSettled.reason);
  }
  const cloudflare: SecretMetadata[] | null =
    cfSettled.status === "fulfilled" ? cfSettled.value : null;
  if (cfSettled.status === "rejected") {
    errors.cloudflare = reasonMessage(cfSettled.reason);
  }
  // CF service token は secret list とは別 API なので独立 settle。失敗しても
  // secret 突合 (= GCP source of truth 経路) には影響させない。
  const cfServiceTokens: SecretMetadata[] | null =
    cfStSettled.status === "fulfilled" ? cfStSettled.value : null;
  if (cfStSettled.status === "rejected") {
    errors.service_tokens = reasonMessage(cfStSettled.reason);
  }

  const serviceTokens = reconcileServiceTokens({
    cfServiceTokens,
    gcpSecrets: gcp,
  });

  const previous = await readSnapshot(env.SNAPSHOT_KV);
  const { rows, diff } = buildInventory({
    gcp,
    github,
    cloudflare,
    previousGcpNames: previous?.names ?? null,
  });

  let snapshotAt: string | null = previous?.captured_at ?? null;
  if (opts.commitSnapshot) {
    const written = await writeSnapshot(
      env.SNAPSHOT_KV,
      gcp.map((s) => s.name),
    );
    snapshotAt = written.captured_at;
  }

  return {
    gcp_project_id: env.GCP_PROJECT_ID,
    rows,
    diff,
    previous_snapshot_at: previous?.captured_at ?? null,
    snapshot_at: snapshotAt,
    snapshot_committed: opts.commitSnapshot === true,
    errors,
    provider_counts: {
      gcp: gcp.length,
      github: github === null ? null : github.length,
      cloudflare: cloudflare === null ? null : cloudflare.length,
      service_tokens:
        cfServiceTokens === null ? null : cfServiceTokens.length,
    },
    service_tokens: serviceTokens,
  };
}

function reasonMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
