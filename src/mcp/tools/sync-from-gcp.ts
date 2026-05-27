import { z } from "zod";
import type { Env } from "../../types";
import {
  gcpProxyCtxFromEnv,
  syncFromGcp,
  type SyncFromGcpResult,
  type SyncFromGcpTarget,
} from "../../providers/gcp";

// `sync_from_gcp` MCP tool: GCP Secret Manager に既にある値を、変えずに
// Cloudflare Secrets Store / GitHub Actions org secret にコピーする。
//
// 動機:
//   `rotate_secret` / `create_secret` は **新値** を tool-call の `new_value` /
//   `initial_value` parameter で受けるため、LLM agent の tool-call JSON に
//   値が乗る。「同じ値を別 provider にも入れたい」だけのケースでは値を
//   chat に貼らせるのは過剰で、context-leak risk が無駄に増える。
//
//   `POST /mcp/sync-from-gcp/:name` HTTP route は値を proxy 内で完結させる
//   が、HTTP-only で `tools/list` に出ないため LLM agent から発見しづらい。
//   実害として ippoan/HealthConnectReaderWorker#61 で「CF にコピーするだけ」
//   の操作を agent が見つけられず長時間迷走した。
//
// 設計:
//   本 tool は HTTP route と **同じ `syncFromGcp()` を呼ぶ薄い wrapper**。
//   入力 schema に value parameter は無く、name と targets だけを受ける。
//   = tool-call JSON に値が載らないため、create/rotate と違って LLM context
//   経由の value leak は構造的に発生しえない。
//
// scope:
//   provider への write は伴うので write tool 扱いで `requiresScope: "mcp.write"`。
//
// Refs ippoan/secrets-inventory#57

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const SYNC_TARGETS: readonly SyncFromGcpTarget[] = ["gh", "cf"] as const;
const VISIBILITY_OPTIONS = ["all", "private", "selected"] as const;

export const syncFromGcpInputSchema = z
  .object({
    name: z
      .string()
      .regex(NAME_PATTERN, "name must match ^[A-Za-z][A-Za-z0-9_-]{0,127}$")
      .describe("GCP source secret 名 (= 既に GCP Secret Manager に存在する secret)"),
    targets: z
      .array(z.enum(["gh", "cf"]))
      .min(1)
      .describe(
        "コピー先 provider 群 (`gh` = GitHub Actions org secret, `cf` = " +
          "Cloudflare Secrets Store)。少なくとも 1 つ。",
      ),
    gh_name: z
      .string()
      .regex(NAME_PATTERN)
      .optional()
      .describe("GitHub 側 secret 名を src と変えたい場合に指定 (省略時は src と同名)"),
    cf_name: z
      .string()
      .regex(NAME_PATTERN)
      .optional()
      .describe("CF 側 secret 名を src と変えたい場合に指定 (省略時は src と同名)"),
    visibility: z
      .enum(VISIBILITY_OPTIONS)
      .optional()
      .describe("GitHub Actions secret visibility (proxy default = `all`)"),
    scopes: z
      .array(z.string())
      .optional()
      .describe("CF Secrets Store scopes (proxy default = `['workers']`)"),
    fail_if_exists: z
      .boolean()
      .optional()
      .describe(
        "true (proxy default) で既存衝突は fail。false で既存 secret 再利用 (新 version 投入)。",
      ),
  })
  .strict();

export type SyncFromGcpToolArgs = z.infer<typeof syncFromGcpInputSchema>;

export const syncFromGcpTool = {
  name: "sync_from_gcp",
  description:
    "GCP Secret Manager の既存値を Cloudflare Secrets Store / GitHub に " +
    "コピー (= mirror / propagate / 複製) する。値は GCP proxy 内で完結し、" +
    "tool-call JSON / response / log には載らない。`create_secret` / " +
    "`rotate_secret` と違って value parameter を持たないため context leak " +
    "risk が構造的にゼロ。「GCP には既にあるが CF / GitHub には未投入」" +
    "ケースで使う。HTTP route は `POST /mcp/sync-from-gcp/:name?targets=...`。",
  inputSchema: syncFromGcpInputSchema,
  requiresScope: "mcp.write" as const,
  execute: async (
    env: Env,
    args: SyncFromGcpToolArgs,
    actorEmail?: string,
  ): Promise<SyncFromGcpResult> => {
    const ctx = await gcpProxyCtxFromEnv(env, actorEmail);
    return await syncFromGcp(
      {
        srcName: args.name,
        targets: args.targets as SyncFromGcpTarget[],
        ghName: args.gh_name,
        cfName: args.cf_name,
        visibility: args.visibility,
        scopes: args.scopes,
        failIfExists: args.fail_if_exists,
      },
      ctx,
    );
  },
} as const;

// SYNC_TARGETS は将来 sync 対象 provider を増やす際の単一参照点として export。
export { SYNC_TARGETS };
