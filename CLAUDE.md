# CLAUDE.md

Claude Code 向けの本リポジトリ作業ルール。

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

## PR description / commit message のキーワード

- 使用禁止: `Closes #N` / `Fixes #N` / `Resolves #N`
  - PR auto-merge が走った瞬間に issue が自動 close されるため、release 時の
    close 確認 UI と整合しない
- 使用推奨: `Refs #N` / `Related to #N` / `Part of #N`
  - GitHub の Development セクションには紐付くが auto-close されない
  - release tag 後に ci-dashboard 経由で目視 close する

PR テンプレートは `.github/pull_request_template.md` で `Refs` を強制する。

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
