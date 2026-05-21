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

## エンドポイント (PR2 時点)

すべて `/api/*` 配下は CF Access 認証必須。

| method | path | 説明 |
|---|---|---|
| GET | `/healthz` | 認証不要 health check |
| GET | `/api/cloudflare/secrets` | CF Secrets Store のメタデータ list |
| GET | `/api/github/secrets` | GitHub org Actions secrets のメタデータ list |
| GET | `/api/gcp/secrets` | GCP Secret Manager のメタデータ list |
| GET | `/api/all` | 3 プロバイダーを並列に叩いて 1 レスポンスにまとめる (partial success 対応) |

## 各プラットフォームの取得方法 (すべて値を返さない / 最小権限)

| プラットフォーム | 取得 | 権限 | 備考 |
|---|---|---|---|
| GCP Secret Manager | `GET /v1/projects/{project}/secrets` | `roles/secretmanager.viewer` のみ (accessor は付けない) | viewer なら値の access は権限エラーで弾かれる。labels も取れる |
| GitHub Actions Secrets | `GET /orgs/{org}/actions/secrets` (REST) | org secrets read (fine-grained PAT) | name, created_at, updated_at, visibility |
| Cloudflare Secrets Store | `GET /accounts/{account_id}/secrets_store/stores/{store_id}/secrets` | Secrets Store Read | name, id, scopes, comment, created/modified |

GCP は SA 鍵から RS256 JWT を作って OAuth2 token endpoint に投げ、`cloud-
platform.read-only` スコープの access token を得る。Web Crypto API のみで完結
させているため、外部 JWT ライブラリの依存は無い (jose は CF Access JWT 検証用)。

## 値の確認は GCP コンソールへ誘導

値が必要なときは GCP コンソールでコピペ取得 (accessor 権限を持つ人間の操作)。
本 Worker からは値を出さず、コンソールへのリンクで誘導する (UI は PR4 以降)。

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
├── index.ts                  # Hono entry。/healthz + CF Access 必須 /api/*
├── types.ts                  # Env / SecretMetadata 等の共通型
├── middleware/
│   └── cf-access.ts          # Cloudflare Access JWT (jose) 検証 middleware
├── providers/
│   ├── cloudflare.ts         # CF Secrets Store list
│   ├── github.ts             # GitHub org Actions secrets list (paginated)
│   └── gcp.ts                # GCP Secret Manager list (SA JWT auth, paginated)
└── routes/
    └── list.ts               # /api/{provider}/secrets と /api/all
```

新しい provider を足す場合は `src/providers/*.ts` に list 関数を書き、
`SecretMetadata[]` を返すように map する。`src/routes/list.ts` から呼ぶ。

## ステータス / ロードマップ

- [x] PR1 雛形 + 認証 (本 branch)
- [x] PR2 各プラットフォーム read (本 branch)
- [ ] PR3 突合 + 差分検知 (KV スナップショット)
- [ ] PR4 UI (突合ビュー)
- [ ] PR5 ci-dashboard リンク

詳細は [issue #1](https://github.com/ippoan/secrets-inventory/issues/1) を参照。

## 開発ルール

- branch / worktree 命名と `Refs #N` 規約: [`CLAUDE.md`](CLAUDE.md)
- PR テンプレート: [`.github/pull_request_template.md`](.github/pull_request_template.md)
