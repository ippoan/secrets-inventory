import { z } from "zod";
import { STATIC_TOOLS } from "../registry";

/**
 * `read_first` MCP tool。LLM agent が **このサーバーを初めて使う時に最初に呼ぶ**
 * 想定の overview / index tool。値は一切扱わず、以下を返す:
 *
 *   1. intro    — このサーバーの方針 (GCP が source of truth、値を context に
 *                 載せないための pipe 経路、3 system 並列投入、etc.)
 *   2. tools    — `STATIC_TOOLS` (= server.ts と共有する registry) を動的に
 *                 列挙して {name, description, requires_scope} を返す。各 tool の
 *                 説明文は tool 定義ファイル自身に書かれている (= single source
 *                 of truth)。
 *   3. http_routes — MCP tool ではなく HTTP route として expose されている
 *                 endpoint (`PUT /mcp/secret-upload/:name` 等) の index。
 *   4. workflows — よく使うシナリオ別の手順 (rotate / create / mint-health-oauth)。
 *
 * 「最初に読め」を tool description で強く誘導する。後続の `tools/call` の前に
 * 1 度叩いてもらえば、その出力に含まれる workflows と tool 説明だけで
 * 通常タスクを完遂できる前提でドキュメントを構成する。
 *
 * 注: 自分自身は `tools` 配列に含めない (= 循環参照を避ける + agent は既に
 * `tools/list` で自分を見ている)。
 */

export const readFirstInputSchema = z.object({}).strict();

const INTRO = [
  "secrets-inventory MCP server — 概要",
  "",
  "GCP Secret Manager を **source of truth** として、Cloudflare Secrets Store と",
  "GitHub Actions org secrets の inventory / 値投入 / rotation を統一管理する",
  "MCP server。Cloudflare Workers + Cloud Run proxy 2 段構成で、worker は",
  "credential を一切持たず proxy 1 個に集約する (= `GCP_PROXY_API_KEY` のみ)。",
  "",
  "重要原則:",
  "  1. 値 (secret payload) は **会話 / tool-call JSON / log に一切載せない**。",
  "     必要なら HTTP route の `PUT /mcp/secret-upload/:name` に curl --data-binary",
  "     で raw bytes を流す経路を使う。MCP tool の string parameter で値を渡すと",
  "     LLM context に載るので避ける。",
  "  2. write 系 tool (rotate_secret / create_secret) は binding_jwt の scope に",
  "     `mcp.write` が含まれているときだけ呼べる。read 系 (list_inventory / get_drift /",
  "     get_snapshot / list_service_accounts) は scope 不要。",
  "  3. `targets` パラメータに **必ず `gcp` を含める**。GCP を外すと inventory",
  "     drift 検出が壊れる (= 規約違反、400 で reject される)。",
  "  4. 既存名衝突は `fail_if_exists: true` (default) で 409 / fail。明示的に",
  "     `false` を渡すと既存 secret 再利用 (= 新 version 投入) になる。",
].join("\n");

const HTTP_ROUTES = [
  {
    method: "PUT",
    path: "/mcp/secret-upload/:name",
    purpose:
      "value を HTTP body (raw bytes) で受け取って create / rotate を実行する代替経路。" +
      "?targets=gcp,cf,github&mode=create|rotate&fail_if_exists=true|false。" +
      "tool-call JSON に値を載せたくないとき (= LLM context 経由を避けたいとき) に curl --data-binary @file で叩く。",
  },
  {
    method: "POST",
    path: "/mcp/mint-health-oauth-jwt",
    purpose:
      "auth-worker の /health/oauth が要求する Bearer JWT (HS256 / env.JWT_SECRET) を proxy 内で署名し、" +
      "GCP Secret Manager の `HEALTH_OAUTH_JWT` に新 version を投入する。" +
      "Refs ippoan/auth-worker#209。payload (sub, exp) と入出力 secret 名はすべて proxy 側 hardcode。" +
      "binding_jwt の mcp.write scope 必須。",
  },
];

const WORKFLOWS = {
  rotate_existing_secret: [
    "既存 secret を新しい値で rotate (= 全 system の値を更新):",
    "",
    "  curl -X PUT \\",
    "    'https://security-inventory.ippoan.org/mcp/secret-upload/MY_SECRET?targets=gcp,cf,github&mode=rotate' \\",
    "    -H \"Authorization: Bearer $BINDING_JWT\" \\",
    "    --data-binary @/tmp/new-value",
    "",
    "値が dictionary に乗らない経路。MCP tool `rotate_secret` でも同 logic を呼べるが、value を JSON parameter で渡すので LLM context に載る。",
  ].join("\n"),
  create_new_secret: [
    "新規 secret を 3 system に作成 + 初版を投入:",
    "",
    "  # 値が context に乗らない経路",
    "  curl -X PUT \\",
    "    'https://security-inventory.ippoan.org/mcp/secret-upload/NEW_SECRET?targets=gcp,cf,github&mode=create&fail_if_exists=true' \\",
    "    -H \"Authorization: Bearer $BINDING_JWT\" \\",
    "    --data-binary @/tmp/value",
    "",
    "kebab name (CF binding 用) と SCREAMING_SNAKE (GitHub 用) を同値で並走させたい場合は 2 path 走らせる (cross-name 規約)。",
  ].join("\n"),
  mint_health_oauth_jwt: [
    "auth-worker の /health/oauth 用 JWT を mint (Refs ippoan/auth-worker#209):",
    "",
    "  # 1. 事前に operator が JWT_SECRET の per-secret accessor を grant 済の前提",
    "  curl -X POST \\",
    "    'https://security-inventory.ippoan.org/mcp/mint-health-oauth-jwt' \\",
    "    -H \"Authorization: Bearer $BINDING_JWT\"",
    "",
    "応答は metadata のみ (value は GCP Secret Manager に landing する)。",
    "GitHub Actions org secret に反映するには別途 `/sync-from-gcp/HEALTH_OAUTH_JWT?targets=github` を叩く (proxy 側 endpoint、後続 PR)。",
  ].join("\n"),
  check_drift: [
    "GitHub / Cloudflare に GCP source-of-truth から外れた secret が無いか確認:",
    "",
    "  tools/call get_drift {targets: ['github', 'cloudflare']}",
    "",
    "返ってきた `rows` に in_github=false や in_cloudflare=false が並んでいたら、" +
      "rotate_secret か create_secret で同名を投入して揃える。",
  ].join("\n"),
};

interface ReadFirstResult {
  intro: string;
  tools: Array<{
    name: string;
    description: string;
    requires_scope?: string;
  }>;
  http_routes: typeof HTTP_ROUTES;
  workflows: typeof WORKFLOWS;
}

export const readFirstTool = {
  // tool 名の MUST_READ_FIRST 部分は **大文字** で agent の attention を強く引く。
  // 後段 `or_other_tools_will_fail` で「skip すると後続 tool call が壊れる」と
  // **consequence framing** で抑止力をかける (LLM は consequence を tool 名から
  // 読み取って優先度を上げる傾向がある)。MCP spec は tool 名の case を強制しない。
  name: "MUST_READ_FIRST_or_other_tools_will_fail",
  description:
    "MUST READ FIRST BEFORE CALLING ANY OTHER TOOL ON THIS MCP SERVER. " +
    "Skipping this call will lead to 4xx / 5xx errors, scope-denied responses, value-leak into " +
    "LLM context, or operating-on-the-wrong-secret accidents — all the failure modes this server " +
    "is designed to prevent. " +
    "Returns: (1) server intro / 重要原則 (GCP=source-of-truth、値を context に載せない経路、 " +
    "scope policy)、(2) all other MCP tool names + descriptions + required scopes (= the same " +
    "tools you see in tools/list、まとめて 1 度に読める形)、(3) HTTP-only routes (e.g. " +
    "/mcp/secret-upload/:name, /mcp/mint-health-oauth-jwt) that don't appear in tools/list、 " +
    "(4) common workflows (rotate / create / mint health-oauth JWT / check drift) with concrete " +
    "curl invocations. 入力 args 不要、値を一切扱わず authentication 以外の制約なく いつでも呼べる。",
  inputSchema: readFirstInputSchema,
  execute: async (): Promise<ReadFirstResult> => {
    return {
      intro: INTRO,
      tools: STATIC_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        ...(t.requiresScope ? { requires_scope: t.requiresScope } : {}),
      })),
      http_routes: HTTP_ROUTES,
      workflows: WORKFLOWS,
    };
  },
} as const;
