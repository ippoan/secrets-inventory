# secrets-inventory

GCP / GitHub / Cloudflare にまたがる secret の所在を横断的に把握するためのインベ
ントリ + 突合システム。**GCP を正(source of truth)** とし、GCP の secret 名を
基準に GitHub・Cloudflare と**名前で突合**する。値そのものは扱わず、メタデー
タ(名前・更新日時等)のみを読む。

旧 [`ippoan/cf-secrets-mcp`](https://github.com/ippoan/cf-secrets-mcp)
(Cloudflare 単独 read 専用、archived) を本リポジトリに統合・置き換える予定。

## 設計方針

- **正は GCP**。値の確認・取り出しも名前確認も GCP 基準。
- 突合は **GCP → GitHub** / **GCP → Cloudflare** の片方向(GCP にあるが配布先に
  無い名前=反映漏れ を検知)。
- 毎回全件取得しない。**差分(GCP 側で増えた名前)が出たら確認**する方式。
- 状態(前回の名前一覧スナップショット)は **Cloudflare KV** に保持し、次回取得
  分と diff する。
- 全プラットフォームとも **メタデータのみ read**。値は会話にも UI にも乗せない。

## 各プラットフォームの取得方法(すべて値を返さない / 最小権限)

| プラットフォーム | 取得 | 権限 | 備考 |
|---|---|---|---|
| GCP Secret Manager | `GET /v1/projects/{project}/secrets` | `roles/secretmanager.viewer` のみ(accessor は付けない) | viewer なら値の access は権限エラーで弾かれる。labels も取れる |
| GitHub Actions Secrets | `GET /orgs/{org}/actions/secrets` (REST) | org secrets read (fine-grained PAT) | name, created_at, updated_at, visibility |
| Cloudflare Secrets Store | `GET /accounts/{account_id}/secrets_store/stores/{store_id}/secrets` | Secrets Store Read | name, id, scopes, comment, created/modified |

## 値の確認は GCP コンソールへ誘導

値が必要なときは GCP コンソールでコピペ取得(accessor 権限を持つ人間の操作)。
MCP/UI からは値を出さず、コンソールへのリンクで誘導する。

- 一覧: `https://console.cloud.google.com/security/secret-manager?project=PROJECT_ID`
- 個別: `https://console.cloud.google.com/security/secret-manager/secret/SECRET_NAME/versions?project=PROJECT_ID`

## 認証情報の格納

MCP が使う read token は **Cloudflare Secrets Store** に集約する。

- GitHub org secrets read 用 PAT
- GCP viewer SA の鍵

「インベントリ MCP が読むトークンも Secrets Store 管理」で一貫させる。

## UI

- **MCP + Cloudflare Access(Google OAuth)** で保護した、名前だけの突合ビュー。
- GCP 基準の名前一覧に対し、GitHub / Cloudflare それぞれの有無を列で表示。
- 差分(GCP に増えた / 配布先に無い)をハイライト。
- 値は一切表示せず、必要時は GCP コンソールへのリンクで誘導。

## ステータス

雛形のみ。実装計画と詳細は [issue #1](https://github.com/ippoan/secrets-inventory/issues/1) を参照。
