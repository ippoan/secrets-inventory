# secrets-inventory

GCP / GitHub / Cloudflare にまたがる secret の所在を横断的に把握するためのインベ
ントリ + 突合システム。**GCP を正(source of truth)** とし、GCP の secret 名を
基準に GitHub・Cloudflare と**名前で突合**する。値そのものは扱わず、メタデー
タ(名前・更新日時等)のみを読む。

旧 [`ippoan/cf-secrets-mcp`](https://github.com/ippoan/cf-secrets-mcp)
(Cloudflare 単独 read 専用、archived) を本リポジトリに統合・置き換える予定。

## 設計方針

- **正は GCP**。値の確認・取り出しも名前確認も GCP 基準。
- 突合は **GCP → GitHub** / **GCP → Cloudflare** の片方向 (GCP にあるが配布先
  に無い名前=反映漏れ を検知)。実装は PR3 以降。
- 全プラットフォームとも **メタデータのみ read**。値は会話にも UI にも乗せない。
- 認証は **Cloudflare Access (Google OAuth)** に委譲。Worker 側は
  `Cf-Access-Jwt-Assertion` を検証するだけで、自前のセッション管理はしない。
- インベントリ自身が読む token (GitHub PAT / GCP SA 鍵 / CF API token) は
  **Cloudflare Secrets Store binding 経由**で受け取る。

## 環境構成

**staging が実運用環境**。本番リリースタグ (`v*`) は将来用に予約してあるが、
当面は staging deploy だけを使う。

| env | name | trigger | route |
|---|---|---|---|
| staging (live) | `secrets-inventory-staging` | PR (non-draft) | `workers.dev` + CF Access |
| production | `secrets-inventory` | `v*` tag push | (未割当) |

PR を上げると `frontend-ci.yml` 経由で staging に auto-deploy される。staging
本体は Cloudflare Access (Google OAuth) で保護する。

## エンドポイント

`/` (dashboard) と `/api/*` (JSON) と `/mcp*` (MCP) は Cloudflare Access (Google OAuth) 認証必須。
`/mcp*` は加えて `Authorization: Bearer` の **二重認証**。

| method | path | 説明 |
|---|---|---|
| GET | `/healthz` | 認証不要 health check |
| GET | `/` | 突合 dashboard (HTML)。`?commit=1` で snapshot を更新 |
| GET | `/service-accounts` | GCP SA 監査 dashboard。`?format=json` で JSON |
| GET | `/api/cloudflare/secrets` | CF Secrets Store のメタデータ list |
| GET | `/api/github/secrets` | GitHub org Actions secrets のメタデータ list |
| GET | `/api/gcp/secrets` | GCP Secret Manager のメタデータ list |
| GET | `/api/all` | 3 プロバイダーを並列に叩いて 1 レスポンスにまとめる (partial success 対応) |
| GET | `/api/inventory` | GCP 基準の突合 + 前回 snapshot との diff (JSON)。`?commit=1` で snapshot 更新 |
| GET | `/api/service-accounts` | GCP SA inventory + 5-signal 監査結果 (JSON) |
| POST | `/mcp` | MCP read server (Streamable HTTP, 2025-03-26 spec) |
| GET | `/mcp/sse` | MCP read server legacy SSE (endpoint discovery) |
| POST | `/mcp/sse/message` | MCP read server legacy SSE ingest |
| PUT | `/mcp/secret-upload/:name` | secret value を **HTTP body** で受けて `create_secret` / `rotate_secret` と同じ実行経路に流す (LLM context に value を載せない代替経路、mcp.write 必須)。詳細は [§ secret value を LLM context に乗せずに投入する](#secret-value-を-llm-context-に乗せずに投入する) |

### MCP (read) server (`/mcp*`)

`secrets-inventory` worker は read 機能を **MCP server** としても expose する。
AI client (Claude Code / Claude Desktop / Cline 等の MCP-aware client) から tool
呼び出しでメタデータ突合・SA 監査・snapshot を取得できる。

実装は `@modelcontextprotocol/sdk` (TypeScript SDK) の `Server` class を使い、
Workers の 1 request = 1 response モデルに合わせた薄い `WorkerTransport` bridge
で接続している。`packages/rotate-mcp/` の write MCP server とは別 process / 別
Bearer で運用する (read / write の blast radius を分離)。

提供 tool:

| tool | 引数 | 戻り値 (= dashboard で見える payload と同じ JSON) |
|---|---|---|
| `list_inventory` | `{ commit_snapshot?: boolean }` | `InventoryResult` (3 system 突合 + diff) |
| `list_service_accounts` | `{}` | `SaInventoryResult` (SA + 5-signal 監査) |
| `get_drift` | `{ targets?: ("github" \| "cloudflare")[] }` | drift 行のみ filter した payload |
| `get_snapshot` | `{}` | 前回 GCP snapshot (`SnapshotV1` or `null`) |

認証は CF Access (Google OAuth) + Bearer の二重認証必須:

```
Cf-Access-Jwt-Assertion: <CF Access JWT>
Authorization: Bearer <INVENTORY_MCP_BEARER>
```

Bearer 値は Cloudflare Secrets Store (`inventory-mcp-bearer`) に格納し、worker は
`INVENTORY_MCP_BEARER` binding 経由で読む。Bearer は手動で provisioning し、
30 日ごとに rotation する想定 (`packages/rotate-mcp/` の dogfooding 拡大時に
本 read MCP の bearer も rotate 対象に組み込む)。

### secret value を LLM context に乗せずに投入する

MCP の JSON-RPC で `create_secret` / `rotate_secret` を呼ぶと `initial_value` /
`new_value` parameter が LLM agent の tool-call payload (= LLM の chat
transcript / log) を経由する。base64 keystore のような大きな秘密値をその経路に
流すと露出面が広がるため、HTTP body 経由で同じ実行ロジックを叩ける代替経路
`PUT /mcp/secret-upload/:name` を用意している。

```sh
# mcp.write scope の binding_jwt を Bearer header に乗せ、value は
# `--data-binary @file` で curl の標準入力 / file から直接流す。
# LLM agent の場合は shell tool 経由で実行することで value が tool-call
# JSON に載らない。
curl -X PUT \
  'https://security-inventory.ippoan.org/mcp/secret-upload/HCREADER_RELEASE_KEYSTORE_BASE64?targets=gcp,github&fail_if_exists=true' \
  -H "Authorization: Bearer $MCP_JWT" \
  --data-binary @/tmp/keystore_b64
```

Query parameters:

| key | default | 説明 |
|---|---|---|
| `mode` | `create` | `create` (新規) または `rotate` (既存 secret に新 version) |
| `targets` | `gcp,cf,github` | comma-separated subset。github org secret のみ更新したい時は `targets=github` |
| `fail_if_exists` | `true` | create のみ。`false` で既存 secret 再利用 (= 新 version 投入) |
| `cf_scopes` | (なし) | create のみ。CF Secrets Store の scopes。例 `cf_scopes=workers` |
| `expected_gcp_version_id` | (なし) | rotate のみ、TOCTOU 検証 |

レスポンスは `create_secret` / `rotate_secret` MCP tool と同じ JSON 構造
(`{ok, rotation_id, dry_run: false, results: {gcp, cf, github}}`)。value は
response にも upstream log にも echo されない。

物理的な value の経路:

```
shell ($STORE_PW など) → curl --data-binary @file
                         ↓
                  worker (memory only、KV/Secret Manager に staging 無し)
                         ↓
              既存 executeCreate / executeRotate
                         ↓
        secrets-inventory-gcp proxy `/create-secret` or `/add-version`
                         ↓
                    GCP Secret Manager (永続化)
                         ↓
              proxy `/cf/secrets`, `/gh/secrets/{name}` (伝播)
```

### 別 org の GitHub Actions org secret に配る (`sync_from_gcp` + `gh_org`)

GCP の既存値を**別 org** (例 `ohishi-exp`) の GitHub Actions org secret に伝播する。
proxy が `ippoan-ci-bot` App の installation token で書くため、**per-org PAT は不要**
(App が install された org すべてに書ける。Refs ippoan/secrets-inventory-gcp#51)。

```
# MCP tool: 値は proxy 内で完結、tool-call JSON / context に載らない
tools/call sync_from_gcp {
  name: 'CI_APP_ID', targets: ['gh'], gh_org: 'ohishi-exp',
}
tools/call sync_from_gcp {
  name: 'CI_APP_PRIVATE_KEY_PKCS8', targets: ['gh'],
  gh_org: 'ohishi-exp', gh_name: 'CI_APP_PRIVATE_KEY',
}
```

- **前提 (proxy 運用 setup、一度きり)**: App を対象 org に install +
  Organization permissions → Secrets: Read and write を付与・承認。Cloud Run に
  `GH_APP_ID_SECRET_NAME` / `GH_APP_PRIVATE_KEY_SECRET_NAME` env + runtime SA への
  per-secret accessor grant。setup 無し / App mode 無効時は `GH_EXTRA_ORGS`
  allowlist の per-org PAT に fallback (#49)。
- **後段の罠 (`secrets: inherit` クロス org 不可)**: 配った secret を別 org の
  caller が ippoan reusable (`auto-merge.yml@main` 等) で使う時、`secrets: inherit`
  は **同一 org / enterprise 内の reusable にしか secret を渡さない**。別 org caller
  は named secret を明示渡しする (`secrets: { CI_APP_ID: ${{ secrets.CI_APP_ID }}, … }`)。
  詳細は `ippoan/ci-workflows` の CLAUDE.md / auto-merge.yml の error message。

### placeholder 化済み secret (org Settings からの手動削除待ち)

MCP には secret の hard delete エンドポイントが無い (= 履歴の意図的な保全のため)。
不要になった secret は value を `REMOVED-pending-manual-delete-<YYYY-MM-DD>` で
上書きしてマーキングし、後日 user が GCP Console / GitHub org Settings から
手動削除する運用とする。

現在 placeholder 化されているもの:

| name | placeholder set at | 削除予定 |
|---|---|---|
| `HCREADER_RELEASE_KEY_PASSWORD` | 2026-05-25 | HealthConnectReader workflow から参照外れ済み (Refs #51) |
| `HCREADER_TEST_PROBE` | 2026-05-25 | PR #49 動作確認時の副産物 (Refs #51) |

新規に placeholder 化する場合は `PUT /mcp/secret-upload/:name?targets=gcp,github`
で上書きし、本表に追記する。

### 突合 (`/api/inventory`, `/`)

GCP の名前一覧を基準に、各行 = 1 secret name で以下を返す:

- `in_github` / `in_cloudflare`: 同名が配布先に存在するか (true/false)。
  当該 provider の取得が失敗した時は `null` (UI では `?` 表示)
- `is_new_since_snapshot`: 前回 snapshot に無くて今回 GCP に登場した名前
- `diff.added` / `diff.removed`: 前回 snapshot 全体との差分

前回 snapshot は Cloudflare KV (`SNAPSHOT_KV` binding) に保持する。`?commit=1`
で「今回の GCP 名一覧を新しい snapshot に確定」する明示操作。snapshot の値は
名前リスト + 撮影 timestamp のみで、値は一切持たない。

## 各プラットフォームの取得方法 (すべて値を返さない / 最小権限)

| プラットフォーム | 取得 | 権限 | 備考 |
|---|---|---|---|
| GCP Secret Manager | `GET /v1/projects/{project}/secrets` | `roles/secretmanager.viewer` のみ (accessor は付けない) | viewer なら値の access は権限エラーで弾かれる。labels も取れる |
| GitHub Actions Secrets | `GET /orgs/{org}/actions/secrets` (REST) | org secrets read (fine-grained PAT) | name, created_at, updated_at, visibility |
| Cloudflare Secrets Store | `GET /accounts/{account_id}/secrets_store/stores/{store_id}/secrets` | Secrets Store Read | name, id, scopes, comment, created/modified |

GCP は値の access 権限を Worker に渡したくない (= viewer に閉じたい) ため、
別 repo の Cloud Run proxy ([`ippoan/secrets-inventory-gcp`](https://github.com/ippoan/secrets-inventory-gcp))
が attached SA + ADC で Secret Manager に問い合わせ、メタデータだけを返す。
Worker は shared secret header (`X-Inventory-API-Key`) で proxy を叩くだけで、
GCP credentials を一切持たない。

## 値の確認は GCP コンソールへ誘導

値が必要なときは GCP コンソールでコピペ取得 (accessor 権限を持つ人間の操作)。
本 Worker からは値を出さず、UI の各 secret 名と top-right の `↗ GCP Console`
リンクからコンソールに飛ばす。

- 一覧: `https://console.cloud.google.com/security/secret-manager?project=PROJECT_ID`
- 個別: `https://console.cloud.google.com/security/secret-manager/secret/SECRET_NAME/versions?project=PROJECT_ID`

## 認証情報の格納

インベントリ自身が読む token は **Cloudflare Secrets Store** に集約する。

- `SECRETS_INVENTORY_GITHUB_PAT`: GitHub org secrets read 用 fine-grained PAT
- `SECRETS_INVENTORY_GCP_SA_KEY`: GCP viewer SA の JSON 鍵
- `SECRETS_INVENTORY_CF_API_TOKEN`: Cloudflare Secrets Store Read token

「インベントリ MCP が読むトークンも Secrets Store 管理」で一貫させる。

## ローカル開発

```bash
npm install
npm run dev          # wrangler dev で起動
npm test             # vitest 実行
npm run test:coverage
npm run typecheck    # tsc --noEmit
```

ローカル dev は CF Access middleware が `Cf-Access-Jwt-Assertion` header を
要求するので、curl で直接叩くと 401 が返る。`/healthz` だけは認証不要なので
疎通確認はそちらで。

## デプロイ

`wrangler.jsonc` の以下のプレースホルダーを実値に置換してから deploy する。

### staging (実運用)

- `env.staging.vars.CF_ACCESS_TEAM_DOMAIN` → CF Access の team domain
- `env.staging.vars.CF_ACCESS_AUD` → CF Access Application の Audience tag
- `env.staging.vars.CF_ACCOUNT_ID` / `CF_STORE_ID` → Cloudflare 側
- `env.staging.vars.GITHUB_ORG` → 突合対象の org
- `env.staging.vars.GCP_PROJECT_ID` → 突合対象の GCP project
- `env.staging.secrets_store_secrets[*].store_id` → 同 store_id
- `env.staging.kv_namespaces[0].id` → snapshot 用 KV namespace ID

```bash
npx wrangler deploy --env staging
```

### production (将来用)

PR2 時点では未使用。`v*` タグを push すれば `frontend-ci.yml` の
`deploy-release` job が走る (現状は staging と同設定)。

CI 上では `ippoan/ci-workflows` の `frontend-ci.yml` 経由で:

- PR を上げると **staging** に自動デプロイ
- `v*` タグを push すると **prod** にデプロイ

`CLOUDFLARE_API_TOKEN` secret が repo / org 側に設定されていることが前提
(`secrets: inherit`)。

## アーキテクチャ

```
src/
├── index.ts                  # Hono entry。/healthz unprotected + CF Access 必須 /, /api/*, /mcp*
├── types.ts                  # Env / SecretMetadata 等の共通型
├── diff.ts                   # 突合 + 差分検知の pure ロジック
├── snapshot.ts               # KV (SNAPSHOT_KV) への前回スナップショット r/w
├── gcp-console.ts            # GCP コンソール URL 組み立て (list / per-secret)
├── inventory.ts              # 3 provider fetch + diff + KV を束ねる orchestration
├── sa-inventory.ts           # GCP service accounts inventory + 監査 orchestration
├── ui.ts                     # 突合 dashboard の SSR (HTML 生成、pure)
├── sa-ui.ts                  # SA 監査 dashboard SSR
├── audit/
│   └── sa-flags.ts           # SA 5-signal 監査
├── middleware/
│   ├── cf-access.ts          # Cloudflare Access JWT (jose) 検証 middleware
│   └── bearer.ts             # `/mcp*` 用 Bearer (二重認証)
├── mcp/
│   ├── http-handler.ts       # Hono ↔ MCP SDK Server の HTTP bridge (POST /mcp, SSE)
│   ├── transport.ts          # Workers 向け Transport (1 req = 1 res の bridge)
│   ├── server.ts             # @modelcontextprotocol/sdk Server + tools 登録
│   └── tools/
│       ├── list-inventory.ts
│       ├── list-service-accounts.ts
│       ├── get-drift.ts
│       └── get-snapshot.ts
├── providers/
│   ├── cloudflare.ts         # CF Secrets Store list
│   ├── github.ts             # GitHub org Actions secrets list (paginated)
│   ├── gcp.ts                # GCP Secret Manager list (Cloud Run proxy 経由)
│   └── gcp-iam.ts            # GCP IAM (SA inventory) proxy client
└── routes/
    ├── list.ts               # /api/{provider}/secrets と /api/all
    ├── inventory.ts          # /api/inventory (JSON)
    ├── service-accounts.ts   # /api/service-accounts + /service-accounts HTML
    └── ui.ts                 # / (HTML dashboard handler)

packages/
└── rotate-mcp/               # write MCP server (issue #18 Phase A、別 worker として deploy)
```

新しい provider を足す場合は `src/providers/*.ts` に list 関数を書き、
`SecretMetadata[]` を返すように map する。`src/routes/list.ts` から呼ぶ。

## ステータス / ロードマップ

- [x] PR1 雛形 + 認証 (PR #2)
- [x] PR2 各プラットフォーム read (PR #2)
- [x] PR3 突合 + 差分検知 (KV スナップショット)
- [x] PR4 UI (突合ビュー)
- [ ] PR5 ci-dashboard リンク (ippoan/ci-dashboard 側)

詳細は [issue #1](https://github.com/ippoan/secrets-inventory/issues/1) を参照。

## 開発ルール

- branch / worktree 命名と `Refs #N` 規約: [`CLAUDE.md`](CLAUDE.md)
- PR テンプレート: [`.github/pull_request_template.md`](.github/pull_request_template.md)
