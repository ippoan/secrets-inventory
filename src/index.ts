import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { cfAccessMiddleware, type CfAccessClaims } from "./middleware/cf-access";
import { listRoutes } from "./routes/list";
import { inventoryRoutes } from "./routes/inventory";
import { uiRoutes } from "./routes/ui";

type AppVariables = { cfAccess: CfAccessClaims };

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use("*", cors());

// /healthz は Cloudflare Access の前段でも通したいので middleware より先に置く
app.get("/healthz", (c) =>
  c.json({ ok: true, service: "secrets-inventory" }),
);

// 全ての /api/* と /ui は Cloudflare Access (Google OAuth) 必須。
// Hono の "/ui/*" は exact "/ui" にマッチしないので、root 用と sub-path 用で
// 2 行に分けて宣言する。
app.use("/api/*", cfAccessMiddleware());
app.use("/ui", cfAccessMiddleware());
app.use("/ui/*", cfAccessMiddleware());

app.get("/", (c) =>
  c.html(
    `<!doctype html><meta charset="utf-8"><title>secrets-inventory</title>
<body style="background:#0d1117;color:#c9d1d9;font-family:system-ui;padding:24px;line-height:1.5">
<h1 style="margin-top:0">🔐 secrets-inventory</h1>
<p>GCP / GitHub / Cloudflare の secret 名を横断的に突合する read-only Worker。値は表示しません。</p>
<p>
  <a href="/ui" style="color:#58a6ff">📊 Inventory dashboard</a>
  · <a href="/api/inventory" style="color:#58a6ff">📦 /api/inventory (JSON)</a>
  · <a href="https://github.com/ippoan/secrets-inventory" style="color:#58a6ff">source</a>
</p>
<p style="color:#8b949e;font-size:13px">/ui と /api/* は Cloudflare Access (Google OAuth) で保護されています。</p>
</body>`,
  ),
);

app.route("/api", listRoutes);
app.route("/api", inventoryRoutes);
app.route("/ui", uiRoutes);

export default app;
