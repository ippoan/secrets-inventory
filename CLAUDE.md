# CLAUDE.md

ippoan/secrets-inventory — secret / service-account 横断監査 (メタのみ) + 投入/rotate の MCP server (Cloudflare Workers + Hono)。

## ビルド / テスト

```sh
npm install
npm run typecheck
npm test
```

## 規範 (hard constraint)

- **GCP が正 (source of truth)**。値の確認・取り出しも名前確認も GCP 基準。
- 全プラットフォームとも **メタデータのみ read**。値は会話にも UI にも乗せない。
- 値の access が必要な場面では **GCP コンソールへのリンクで誘導**。Worker 自身は accessor 権限を持たない (viewer のみ)。
- 認証は **Cloudflare Access (Google OAuth)** に委譲。Worker 側は `Cf-Access-Jwt-Assertion` を検証するだけ。自前セッション管理はしない。
- 3 system すべて **`secrets-inventory-gcp` Cloud Run proxy 経由**でアクセス (Refs #45)。Worker が持つ secret binding は `GCP_PROXY_API_KEY` 1 個だけ。CF API token / GitHub PAT は proxy 側 (GCP Secret Manager) に集約。
- **write 系 (rotate_secret / create_secret) は MCP tool 経由のみ**。tool 単位で `requiresScope: "mcp.write"` を立て、binding_jwt の scope が `mcp.write` を含まないと 403 相当を返す。
- **`main` に直 push しない**。PR を開く → CI green → auto-merge。
- **PR / commit**: `Closes` / `Fixes` / `Resolves #N` 禁止。`Refs #N` / `Related to #N` / `Part of #N` を使う。
- **branch**: 先に issue を立て `<issue-number>-<type>-<short-desc>` で切る。issue 番号なし branch で実装に入らない。

## 詳細

詳細 (branch 命名規則・このリポジトリの方針・MCP transport dual-path) は `secrets-inventory-map` skill を参照。
