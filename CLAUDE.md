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
