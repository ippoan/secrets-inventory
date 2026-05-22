import type { Env } from "./types";
import {
  listServiceAccounts,
  GcpIamProxyError,
  type ServiceAccount,
} from "./providers/gcp-iam";
import {
  auditServiceAccount,
  summarize,
  type SaAudit,
  type SaAuditSummary,
} from "./audit/sa-flags";

export class GcpIamUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GcpIamUnavailableError";
  }
}

export interface SaInventoryRow {
  sa: ServiceAccount;
  audit: SaAudit;
}

export interface SaInventoryResult {
  gcp_project_id: string;
  fetched_at: string;
  rows: SaInventoryRow[];
  summary: SaAuditSummary;
}

/**
 * SA inventory orchestrator。Cloud Run proxy から SA + roles + keys を取得し、
 * 各 SA を 5 シグナル監査して row + summary を返す。
 *
 * proxy が落ちている場合は `GcpIamUnavailableError` で 502 に bubble する
 * (= secret inventory の `GcpUnavailableError` と同じ pattern)。
 */
export async function gatherSaInventory(env: Env): Promise<SaInventoryResult> {
  let sas: ServiceAccount[];
  try {
    const proxyApiKey = await env.GCP_PROXY_API_KEY.get();
    sas = await listServiceAccounts({
      proxyUrl: env.GCP_PROXY_URL,
      apiKey: proxyApiKey,
    });
  } catch (err) {
    if (err instanceof GcpIamProxyError) {
      throw new GcpIamUnavailableError(err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new GcpIamUnavailableError(message);
  }

  const now = new Date();
  const rows: SaInventoryRow[] = sas.map((sa) => ({
    sa,
    audit: auditServiceAccount(sa, now),
  }));
  // candidate → warn → ok の順、同 status 内では email asc。
  rows.sort((a, b) => {
    const order = { candidate: 0, warn: 1, ok: 2 } as const;
    if (order[a.audit.status] !== order[b.audit.status]) {
      return order[a.audit.status] - order[b.audit.status];
    }
    return a.sa.email.localeCompare(b.sa.email);
  });

  return {
    gcp_project_id: env.GCP_PROJECT_ID,
    fetched_at: now.toISOString(),
    rows,
    summary: summarize(rows.map((r) => r.audit)),
  };
}
