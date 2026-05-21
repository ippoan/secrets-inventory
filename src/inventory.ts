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
 * snapshot との diff を返す。GitHub / CF の fetch 失敗は partial-success
 * (errors に reason を載せて該当列を `null` に) として扱う。
 */
export async function gatherInventory(
  env: Env,
  opts: GatherOptions = {},
): Promise<InventoryResult> {
  const [gcpToken, ghToken, cfToken] = await Promise.all([
    env.GCP_PROXY_API_KEY.get(),
    env.GITHUB_PAT.get(),
    env.CF_API_TOKEN.get(),
  ]);

  const [gcpSettled, ghSettled, cfSettled] = await Promise.allSettled([
    listGcpSecrets({ proxyUrl: env.GCP_PROXY_URL, apiKey: gcpToken }),
    listGitHubOrgSecrets({ token: ghToken, org: env.GITHUB_ORG }),
    listCloudflareSecrets({
      token: cfToken,
      accountId: env.CF_ACCOUNT_ID,
      storeId: env.CF_STORE_ID,
    }),
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
  };
}

function reasonMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
