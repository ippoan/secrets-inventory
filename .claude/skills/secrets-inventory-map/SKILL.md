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
