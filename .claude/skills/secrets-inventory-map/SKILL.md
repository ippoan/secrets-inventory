---
name: secrets-inventory-map
generated-from: secrets-inventory:efaeac91b0b08cd988357a2ce1e664d09633e8ee
paths: [src/]
description: ippoan/secrets-inventory (Cloudflare Workers + Hono、secret/service-account 監査 + 投入/rotate の MCP server) の構造ナビゲーション。GCP=SoT・メタのみ read・値は会話に載せない方針、CF Access (人間) と binding_jwt (MCP) の二重認証、secrets-inventory-gcp Cloud Run proxy 集約、stateless `/mcp` と stateful `/mcp-do` dual-path の配置と gotcha を 1 枚にまとめる。トリガー:「secrets-inventory」「secret 監査」「create_secret」「rotate_secret」「service account 監査」「drift」「snapshot」「binding_jwt」「mcp.write scope」「GCP proxy」「secret-upload」「SecretsInventoryMcp」「set_repo_variable」「repo variable」「Actions variable」等。
---

# secrets-inventory-map — ippoan/secrets-inventory 構造ナビゲーション

Cloudflare Workers (Hono) ベース。**secret / service-account の横断監査 (メタのみ)
+ 投入/rotate の MCP server**。値は GCP を source-of-truth とし、3 system (GCP /
Cloudflare / GitHub) すべて `secrets-inventory-gcp` Cloud Run proxy 経由でアクセス
する (worker 自身は accessor 権限を持たない)。

> 細部 (関数シグネチャ・正確な行) は repo 側が正。ここは「どこを見るか」の索引。
> frontmatter の `generated-from` が現在の tree-sha とズレたら
> session-start-skill-coverage hook が再生成を促す → その時 tree-sha を更新する。

## 区画

| module | 主要ファイル | 役割 |
|---|---|---|
| **entry** | `src/index.ts` | Hono 全 route + middleware mount + DO export |
| **MCP** | `src/mcp/{server,registry,http-handler,durable,transport}.ts` + `src/mcp/tools/*` | tool 群 (registry が SoT)、stateless/stateful 両 transport が共有 |
| **REST routes** | `src/routes/{list,inventory,service-accounts,secret-upload,sync-from-gcp,convert-pkcs8,mint-health-oauth-jwt,ui}.ts` | `/api/*` (CF Access) / `/mcp/*` write entry / dashboard |
| **auth** | `src/middleware/cf-access.ts` (人間) `middleware/binding-jwt.ts` (MCP, scope check) | 二重認証 |
| **providers** | `src/providers/{gcp,gcp-iam,cloudflare,github}.ts` | proxy 経由の 3 system メタ取得 |
| **監査ロジック** | `src/inventory.ts` `snapshot.ts` `diff.ts` `sa-inventory.ts` `sa-ui.ts` `service-tokens.ts` `gcp-console.ts` `audit/sa-flags.ts` | inventory / drift / SA flag 判定 |
| **DO** | `src/mcp/durable.ts` (`SecretsInventoryMcp`) | agents SDK McpAgent。`/mcp-do` (DO+WS) transport |

### MCP tools (`src/mcp/tools/*`, registry が single source)

read: `list_inventory` `get_snapshot` `get_drift` `list_service_accounts` `list_repo_variables`
write (`requiresScope: mcp.write`): `create_secret` `rotate_secret` `dry_run_rotate`
`sync_from_gcp` `create_service_token` `rotate_service_token` `delete_service_token`
`set_repo_variable`
（`rotate_secret` 等は type-to-confirm + protected-id ガード付き）

`set_repo_variable` / `list_repo_variables` は **GitHub Actions repo variable**
(平文 config、secret ではない) を proxy `/gh/variables` 経由で操作する
(`src/mcp/tools/repo-variable.ts` + `src/providers/github.ts`)。value は config 値
なので tool-call JSON に載せてよい (秘匿値は `create_secret` を使う)。用途例:
CI deploy gate の `STAGING_DEPLOY_ENABLED=true` を Settings UI を触らず設定。

## entrypoint (`src/index.ts` の route)

- `GET /healthz` (Access 前段、no auth)
- `/api/*` → `cfAccessMiddleware` (Google OAuth) → `list` / `inventory` / `service-accounts`
- `/mcp` `/mcp/*` → `bindingJwtMiddleware` → `POST /mcp` (Streamable HTTP) / `GET /mcp/sse` + `POST /mcp/sse/message` (legacy)
- `ALL /mcp-do` → `handleDurableMcp` (DO+WS、別 path なので上の middleware 非適用、auth は handler 内)
- write entry (`/mcp/*` JWT 配下): `/mcp/secret-upload/:name` (value を raw body で受け context leak 回避) `/mcp/mint-health-oauth-jwt` `/mcp/sync-from-gcp/:name` `/mcp/convert-pkcs8/:name`
- `GET /` (突合 dashboard) `/service-accounts` (SA 監査) — per-route CF Access
- `export { SecretsInventoryMcp }`

## gotcha (CLAUDE.md / wrangler 由来)

- **GCP が SoT**。全 system **メタのみ read**、値は会話/UI/log に一切載せない。値が要る時は **GCP コンソールへのリンクで誘導** (worker は viewer のみ)。
- **proxy 集約 (#45)**: worker が持つ secret binding は `GCP_PROXY_API_KEY` 1 個だけ。CF API token / GitHub PAT は proxy 側 (GCP Secret Manager) に集約。`GCP_PROXY_URL` は Cloud Run staging URL。
- **read/write 認可分離**: 同一 `/mcp` route 上で write tool だけ `requiresScope: "mcp.write"`。binding_jwt の scope が `mcp.write` を含まないと拒否。
- **`/mcp/secret-upload/:name` は value を HTTP raw body で受ける** = `create_secret` MCP tool の JSON param に値を載せたくない (LLM context leak 回避) 用途。`secret-inject` skill がこの経路を使う。
- **MCP は edge で binding_jwt 検証**、CF Access は `/mcp` で **bypassAll** (MCP client は browser OAuth を踏めないため)。代わりに WWW-Authenticate で connector の OAuth 2.1 auto-discovery (RFC 9728) を起動。
- **dual-path MCP (#70)**: stateless `/mcp` は deploy 時に live session の `tools/list` が旧 schema で凍結する実害がある。stateful `/mcp-do` (DO+WS) は deploy で WS drop → Claude Code 再接続 → 新 schema 取得。tool 群は同一 registry を共有。`notifications/tools/list_changed` push は client 未消費なので当てにしない。
- **prod/staging dual-env**。`AUTH_WORKER_ORIGIN` は prod=`auth.ippoan.org` / staging=`auth-staging`。DO+WS lib `@ippoan/mcp-cf-workers` は GitHub Packages `dev` dist-tag を consume。

## CCoW / CI から見た立ち位置

- **ippoan の secret 監査・投入の中枢**。`secret-inject` skill が OAT→binding_jwt(mcp.write)→`/mcp/secret-upload` で no-leak 投入。他 worker (HealthConnectReaderWorker / ci-dashboard 等) の secret は CF Secrets Store + GCP に同名投入する運用。
- 値の実体アクセスは **secrets-inventory-gcp** Cloud Run proxy に委譲 (この repo は facade)。

## 関連 skill

- `secret-inject` — OAT→mcp.write JWT→secret-upload の no-leak 投入 (この worker が受け口)
- `auth-worker-map` — binding_jwt mint 元 (`grant-via-oat`)
- `ippoan-infra-map` / `cross-repo-symbol-index` — 基盤地図 / 鮮度 hook

## CLAUDE.md から移設 (2026-07-07)

## Worktree / branch 命名規則

形式: `<issue-number>-<type>-<short-description>`

- `issue-number`: 必須。先に issue を立ててから worktree / branch を作る
- `type`: `feat` | `fix` | `refactor` | `infra`
- `short-description`: 半角小文字英数字とハイフン

例:

- `1-feat-inventory-scaffold`
- `2-fix-gcp-jwt-clock-skew`

issue 番号を持たない branch (Claude Code が自動採番する `claude/...` 等)
で実装に入る前に、対応する issue を作成し、上記の形式で rename / 再切り出し
すること。

## このリポジトリの方針

- **GCP が正(source of truth)**。値の確認・取り出しも名前確認も GCP 基準
- 全プラットフォームとも **メタデータのみ read**。値は会話にも UI にも乗せない
- 値の access が必要な場面では **GCP コンソールへのリンクで誘導**する。Worker
  自身は accessor 権限を持たない (viewer のみ)
- 認証は **Cloudflare Access (Google OAuth)** に委譲。Worker 側は
  `Cf-Access-Jwt-Assertion` を検証するだけで、自前のセッション管理はしない
- 3 system すべて **`secrets-inventory-gcp` Cloud Run proxy 経由**でアクセス
  (Refs #45)。worker が持つ secret binding は `GCP_PROXY_API_KEY` 1 個だけ。
  CF API token / GitHub PAT は proxy 側 (GCP Secret Manager) に集約
- write 系 (rotate_secret / create_secret) は MCP tool 経由のみ。tool 単位で
  `requiresScope: "mcp.write"` を立て、binding_jwt の scope が `mcp.write`
  を含まないと 403 相当を返す (= 同一 `/mcp` route 上で read/write を分離
  認可)。Refs #45 Stage 2 で旧 `secrets-rotate-mcp` worker は廃止

## MCP transport: stateless `/mcp` と stateful `/mcp-do` の dual-path (Refs #70)

- 「worker 最小・ロジックは proxy 集約」方針の **意図的例外**として、stateful な
  Durable Object (`SecretsInventoryMcp`, agents SDK `McpAgent` ベース) を 1 個
  持ち込む。これは ippoan/mcp-cf-workers#6 の DO+WS transport を consume するもの。
- 理由: stateless `/mcp` は deploy 時に live session の `tools/list` が旧 schema で
  凍結する (#70 実害)。DO+WS の `/mcp-do` は deploy で WS drop → Claude Code 自動
  再接続 → initialize/tools/list 再取得、で新 schema を引ける (Gate A、実証済み)。
- **dual-path 段階移行**: 既存 `/mcp` (`src/mcp/http-handler.ts` + `transport.ts`)
  は温存し、`/mcp-do` (`src/mcp/durable.ts`) を併設。tool 群は同一 registry
  (`src/mcp/registry.ts`) を single source として両 path が共有する。staging で
  Gate A を実証してから本番 `/mcp` の切替を判断する。
- runtime の `notifications/tools/list_changed` push は Claude Code クライアントが
  未消費なので当てにしない (ippoan/mcp-cf-workers#12 で wire 実証 + upstream
  anthropics/claude-code#4118 既知問題)。`/mcp-do` の価値は deploy→reconnect のみ。
- DO+WS lib (`@ippoan/mcp-cf-workers`) は GitHub Packages の `dev` dist-tag を
  consume する。CI/deploy は `frontend-ci.yml` の `npm_scope: '@ippoan'` +
  `permissions.packages: read` で pull する (`.npmrc` 同梱)。
- 認可は stateless 版と同一: edge の `introspectBindingJwt` (binding_jwt 検証) が
  返す `scope` を DO session の `props` に載せ、write tool を `requiresScope` で
  gate する。
