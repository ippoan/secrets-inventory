import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { cfAccessMiddleware, type CfAccessClaims } from "./middleware/cf-access";
import {
  bindingJwtMiddleware,
  type BindingJwtClaims,
} from "./middleware/binding-jwt";
import { listRoutes } from "./routes/list";
import { inventoryRoutes } from "./routes/inventory";
import { serviceAccountsRoutes, handleSaDashboard } from "./routes/service-accounts";
import { secretUploadRoutes } from "./routes/secret-upload";
import { handleDashboard } from "./routes/ui";
import {
  streamableHttpPost,
  legacySseGet,
  legacySsePost,
} from "./mcp/http-handler";

type AppVariables = { cfAccess: CfAccessClaims; bindingJwt: BindingJwtClaims };

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use("*", cors());

// /healthz は Cloudflare Access の前段でも通したいので middleware より先に置く
app.get("/healthz", (c) =>
  c.json({ ok: true, service: "secrets-inventory" }),
);

// /api/* は CF Access (Google OAuth) 必須
app.use("/api/*", cfAccessMiddleware());

// /mcp と /mcp/* は auth-worker (`AUTH_WORKER_ORIGIN`) が mint した
// `binding_jwt` で認証する (Refs #43)。CF Access は edge で **bypassAll** に
// 設定されており (MCP client は browser OAuth flow を踏めないため)、worker
// 側にも CF Access middleware を載せない。代わりに WWW-Authenticate header
// を返して claude.ai connector の OAuth 2.1 auto-discovery (RFC 9728) を
// 起動させる。
// Hono の `/mcp/*` は `/mcp/foo` 以下しかマッチしないため、`/mcp` 自身にも
// 同じ middleware を別途 mount する。
app.use("/mcp", bindingJwtMiddleware());
app.use("/mcp/*", bindingJwtMiddleware());

// MCP transport endpoints。
// - POST /mcp                   : Streamable HTTP (推奨、2025-03-26 spec)
// - GET  /mcp/sse               : Legacy HTTP+SSE 互換 (2024-11-05 spec)
// - POST /mcp/sse/message       : Legacy SSE の message ingest
app.post("/mcp", streamableHttpPost);
app.get("/mcp/sse", legacySseGet);
app.post("/mcp/sse/message", legacySsePost);

// /mcp/secret-upload/:name : value を HTTP body (raw bytes) で受け取る
// 代替 entry point。`create_secret` / `rotate_secret` MCP tool の JSON
// parameter に value を載せたくない (= LLM context に乗せたくない) 用途
// で、authenticated agent が shell から `curl --data-binary @file` で直接
// 流す。auth は `/mcp/*` の bindingJwtMiddleware がそのまま効く (mcp.write
// scope 必須は route 内で再 check)。
app.route("/", secretUploadRoutes);

// root `/` は突合 dashboard。CF Access middleware を per-route で適用する
// (`app.use("/", ...)` だと /healthz など全 path にもマッチしてしまうため)。
app.get("/", cfAccessMiddleware(), handleDashboard);

// /service-accounts は SA 監査 dashboard。同じく per-route で CF Access。
app.get("/service-accounts", cfAccessMiddleware(), handleSaDashboard);

app.route("/api", listRoutes);
app.route("/api", inventoryRoutes);
app.route("/api", serviceAccountsRoutes);

export default app;
