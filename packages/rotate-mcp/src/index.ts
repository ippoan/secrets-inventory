import { Hono } from "hono";
import type { Env, AppVariables } from "./types";
import { cfAccessMiddleware } from "./middleware/cf-access";
import { bearerMiddleware } from "./middleware/bearer";
import {
  streamableHttpPost,
  legacySseGet,
  legacySsePost,
} from "./mcp/transport";

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

// CF Access + Bearer の二重認証を `/mcp/*` 全体に適用。
app.use("/mcp/*", cfAccessMiddleware());
app.use("/mcp/*", bearerMiddleware());

// Streamable HTTP (推奨 transport)
app.post("/mcp", streamableHttpPost);

// Legacy HTTP+SSE 互換 (`@modelcontextprotocol/sdk` 0.x client や Claude Desktop
// 旧版用)。Phase A では mock 接続実装。
app.get("/mcp/sse", legacySseGet);
app.post("/mcp/sse/message", legacySsePost);

// それ以外の `/mcp/*` は 404。
app.all("/mcp/*", (c) => c.json({ error: "not found" }, 404));

export default app;
