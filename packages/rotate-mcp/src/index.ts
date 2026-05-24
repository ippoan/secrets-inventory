import { Hono } from "hono";
import type { Env, AppVariables } from "./types";
import { bindingJwtMiddleware } from "./middleware/binding-jwt";
import {
  streamableHttpPost,
  legacySseGet,
  legacySsePost,
} from "./mcp/transport";

export interface CreateAppOptions {
  /** test 用 override。binding_jwt verify 用の introspect fetch を差し替える。 */
  introspectFetch?: typeof fetch;
}

/**
 * Hono app を組み立てる factory。test では override を渡して remote 依存を
 * bypass する。本番 (default export) は何も渡さない。
 *
 * Refs #43 で `/mcp*` 認証は auth-worker `binding_jwt` (= `bindingJwtMiddleware`)
 * 1 段のみ。CF Access は edge で bypassAll に設定済みであり、worker 側に
 * cfAccessMiddleware を載せると `Cf-Access-Jwt-Assertion` 欠落で 401 になる。
 * cf-access middleware は browser route が増えた時のために file は残してある。
 */
export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  // 公開 health endpoint。CF Access の手前で叩かれる可能性があるため認証不要。
  app.get("/health", (c) =>
    c.json({
      ok: true,
      name: c.env.MCP_SERVER_NAME,
      version: c.env.MCP_SERVER_VERSION,
      protocol: c.env.MCP_PROTOCOL_VERSION,
    }),
  );

  // binding_jwt verify を `/mcp` と `/mcp/*` に適用。Hono の `/mcp/*` は
  // `/mcp/foo` 以下しかマッチしないため、`/mcp` 自身にも別途 mount する
  // (= POST /mcp が unauth で通り抜ける旧 bug の structural fix も兼ねる)。
  const authMw = bindingJwtMiddleware({ introspectFetch: options.introspectFetch });
  app.use("/mcp", authMw);
  app.use("/mcp/*", authMw);

  // Streamable HTTP (推奨 transport)
  app.post("/mcp", streamableHttpPost);

  // Legacy HTTP+SSE 互換 (`@modelcontextprotocol/sdk` 0.x client や Claude Desktop
  // 旧版用)。Phase A では mock 接続実装。
  app.get("/mcp/sse", legacySseGet);
  app.post("/mcp/sse/message", legacySsePost);

  // それ以外の `/mcp/*` は 404。
  app.all("/mcp/*", (c) => c.json({ error: "not found" }, 404));

  return app;
}

export default createApp();
