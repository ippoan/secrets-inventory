import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { cfAccessMiddleware, type CfAccessClaims } from "./middleware/cf-access";
import { bearerMiddleware } from "./middleware/bearer";
import { listRoutes } from "./routes/list";
import { inventoryRoutes } from "./routes/inventory";
import { serviceAccountsRoutes, handleSaDashboard } from "./routes/service-accounts";
import { handleDashboard } from "./routes/ui";
import {
  streamableHttpPost,
  legacySseGet,
  legacySsePost,
} from "./mcp/http-handler";

type AppVariables = { cfAccess: CfAccessClaims };

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use("*", cors());

// /healthz は Cloudflare Access の前段でも通したいので middleware より先に置く
app.get("/healthz", (c) =>
  c.json({ ok: true, service: "secrets-inventory" }),
);

// /api/* は CF Access (Google OAuth) 必須
app.use("/api/*", cfAccessMiddleware());

// /mcp と /mcp/* は CF Access (Google OAuth) + Bearer の二重認証必須。
// CF Access が人間判定、Bearer が AI client (tool 呼び出し単位) を identify する。
// MCP の流入経路は AI agent のみを想定しているため、両方を必須にしている。
// Hono の `/mcp/*` は `/mcp/foo` 以下しかマッチしないため、`/mcp` 自身にも
// 同じ middleware を別途 mount する。
app.use("/mcp", cfAccessMiddleware(), bearerMiddleware());
app.use("/mcp/*", cfAccessMiddleware(), bearerMiddleware());

// MCP transport endpoints。
// - POST /mcp                   : Streamable HTTP (推奨、2025-03-26 spec)
// - GET  /mcp/sse               : Legacy HTTP+SSE 互換 (2024-11-05 spec)
// - POST /mcp/sse/message       : Legacy SSE の message ingest
app.post("/mcp", streamableHttpPost);
app.get("/mcp/sse", legacySseGet);
app.post("/mcp/sse/message", legacySsePost);

// root `/` は突合 dashboard。CF Access middleware を per-route で適用する
// (`app.use("/", ...)` だと /healthz など全 path にもマッチしてしまうため)。
app.get("/", cfAccessMiddleware(), handleDashboard);

// /service-accounts は SA 監査 dashboard。同じく per-route で CF Access。
app.get("/service-accounts", cfAccessMiddleware(), handleSaDashboard);

app.route("/api", listRoutes);
app.route("/api", inventoryRoutes);
app.route("/api", serviceAccountsRoutes);

export default app;
