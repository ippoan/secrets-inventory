import type { Env, SecretMetadata } from "./types";
import { listCloudflareSecrets } from "./providers/cloudflare";
import { listGitHubOrgSecrets } from "./providers/github";
import { listGcpSecrets } from "./providers/gcp";
import { buildInventory, type InventoryRow, type InventoryDiff } from "./diff";
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
  /** github / cloudflare が落ちた時のメッセージ。GCP が落ちると throw。 */
  errors: { github?: string; cloudflare?: string };
  /**
   * 各 provider の取得件数。`null` は fetch 失敗 (errors に reason 入り)。
   * 「赤バナーが出ていないだけで、何件取れたか分からない」を UI 側で
   * 解消するために生件数を持っておく。
   */
  provider_counts: {
    gcp: number;
    github: number | null;
    cloudflare: number | null;
  };
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
  const [gcpSettled, ghSettled, cfSettled] = await Promise.allSettled([
    (async () => {
      const apiKey = await env.GCP_PROXY_API_KEY.get();
      return listGcpSecrets({ proxyUrl: env.GCP_PROXY_URL, apiKey });
    })(),
    (async () => {
      const token = await env.GITHUB_PAT.get();
      return listGitHubOrgSecrets({ token, org: env.GITHUB_ORG });
    })(),
    (async () => {
      const token = await env.CF_API_TOKEN.get();
      return listCloudflareSecrets({
        token,
        accountId: env.CF_ACCOUNT_ID,
        storeId: env.CF_STORE_ID,
      });
    })(),
  ]);

  if (gcpSettled.status === "rejected") {
    throw new GcpUnavailableError(gcpSettled.reason);
  }
  const gcp = gcpSettled.value;

  const errors: { github?: string; cloudflare?: string } = {};
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
    },
  };
}

function reasonMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
