import { z } from "zod";
import type { Env } from "../../types";
import type { ToolContext } from "../registry";
import { PAM_API, callGoogleApi, userAccessToken } from "../../providers/gcp-user";

// `request_write_access` / `get_write_access` MCP tool (Refs #101)。
//
// MCP にログインした人 (claude@ippoan.org) **本人として** PAM に申請する。承認者 (honda@)
// が承認すると、その人に期限付きで権限が付き、`generate_secret` などが書けるようになる。
// 申請者も権限が付く相手もログインした人で、この worker / proxy の SA ではない。
//
// 承認の通知と画面は ippoan/pam-approver (approve.ippoan.org)。PAM のメールでも承認できる。

const ENTITLEMENT_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const APPROVE_URL = "https://approve.ippoan.org/approve";
// まだ使える (= 新しく申請しなくてよい) grant の状態
const LIVE_STATES = new Set(["APPROVAL_AWAITED", "SCHEDULED", "ACTIVATING", "ACTIVE"]);

interface Grant {
  name: string;
  state?: string;
  requestedDuration?: string;
  createTime?: string;
  justification?: { unstructuredJustification?: string };
  timeline?: unknown;
}

function entitlementName(env: Env, entitlement: string): string {
  return `projects/${env.GCP_PROJECT_ID}/locations/global/entitlements/${entitlement}`;
}

function summarize(grant: Grant) {
  return {
    grant: grant.name,
    state: grant.state,
    requested_duration: grant.requestedDuration,
    created_at: grant.createTime,
    justification: grant.justification?.unstructuredJustification,
    approve_url: `${APPROVE_URL}?grant=${encodeURIComponent(grant.name)}`,
  };
}

async function myGrants(env: Env, token: string, entitlement: string): Promise<Grant[]> {
  const url = new URL(`${PAM_API}/${entitlementName(env, entitlement)}/grants:search`);
  url.searchParams.set("callerRelationship", "HAD_CREATED");
  url.searchParams.set("pageSize", "20");
  const res = await callGoogleApi<{ grants?: Grant[] }>(token, url.toString());
  return (res.grants ?? []).sort((a, b) => (b.createTime ?? "").localeCompare(a.createTime ?? ""));
}

const entitlementField = z
  .string()
  .regex(ENTITLEMENT_PATTERN)
  .default("secret-write")
  .describe(
    "PAM の entitlement id (cloudsql-sv)。既定 `secret-write` (Secret Manager の書き込み)。" +
      "他に `run-admin` / `iam-sa-admin` / `secret-read-cf` など",
  );

export const requestWriteAccessInputSchema = z
  .object({
    entitlement: entitlementField,
    justification: z
      .string()
      .min(10)
      .max(500)
      .describe("何のために使うか (承認者に見える)。対象の secret 名なども書く"),
    duration_minutes: z
      .number()
      .int()
      .min(5)
      .max(60)
      .default(30)
      .describe("権限が要る時間 (分)。entitlement の上限を超えると PAM が拒否する"),
  })
  .strict();

export const requestWriteAccessTool = {
  name: "request_write_access",
  description:
    "MCP にログインした人 (Google) として、PAM に一時的な権限を申請する。承認者が承認すると " +
    "期限付きで権限が付き、`generate_secret` などの書き込みができるようになる。承認待ち・有効な " +
    "申請が既にあれば、新しく作らずにそれを返す。返り値の `approve_url` が承認画面。",
  inputSchema: requestWriteAccessInputSchema,
  requiresScope: "mcp.write" as const,
  execute: async (
    env: Env,
    args: z.infer<typeof requestWriteAccessInputSchema>,
    actorEmail?: string,
    ctx?: ToolContext,
  ) => {
    const token = await userAccessToken(env, ctx);
    const live = (await myGrants(env, token, args.entitlement)).find((g) => LIVE_STATES.has(g.state ?? ""));
    if (live) return { created: false, ...summarize(live) };

    const grant = await callGoogleApi<Grant>(
      token,
      `${PAM_API}/${entitlementName(env, args.entitlement)}/grants`,
      {
        method: "POST",
        body: {
          requestedDuration: `${args.duration_minutes * 60}s`,
          justification: {
            unstructuredJustification: `${args.justification} (via secrets-inventory MCP${actorEmail ? `, ${actorEmail}` : ""})`,
          },
        },
      },
    );
    return {
      created: true,
      ...summarize(grant),
      next: "承認されると state が ACTIVE になる。`get_write_access` で確認してから書き込む",
    };
  },
};

export const getWriteAccessInputSchema = z.object({ entitlement: entitlementField }).strict();

export const getWriteAccessTool = {
  name: "get_write_access",
  description:
    "MCP にログインした人が PAM に出した申請の状態 (APPROVAL_AWAITED / ACTIVE / ENDED など) を " +
    "新しい順に返す。ACTIVE なら期限内は書き込める。",
  inputSchema: getWriteAccessInputSchema,
  requiresScope: "mcp.write" as const,
  execute: async (
    env: Env,
    args: z.infer<typeof getWriteAccessInputSchema>,
    _actorEmail?: string,
    ctx?: ToolContext,
  ) => {
    const token = await userAccessToken(env, ctx);
    const grants = await myGrants(env, token, args.entitlement);
    return {
      entitlement: args.entitlement,
      active: grants.some((g) => g.state === "ACTIVE"),
      grants: grants.map(summarize),
    };
  },
};
