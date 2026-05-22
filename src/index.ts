import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { cfAccessMiddleware, type CfAccessClaims } from "./middleware/cf-access";
import { listRoutes } from "./routes/list";
import { inventoryRoutes } from "./routes/inventory";
import { serviceAccountsRoutes, handleSaDashboard } from "./routes/service-accounts";
import { handleDashboard } from "./routes/ui";

type AppVariables = { cfAccess: CfAccessClaims };

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use("*", cors());

// /healthz は Cloudflare Access の前段でも通したいので middleware より先に置く
app.get("/healthz", (c) =>
  c.json({ ok: true, service: "secrets-inventory" }),
);

// /api/* は CF Access (Google OAuth) 必須
app.use("/api/*", cfAccessMiddleware());

// root `/` は突合 dashboard。CF Access middleware を per-route で適用する
// (`app.use("/", ...)` だと /healthz など全 path にもマッチしてしまうため)。
app.get("/", cfAccessMiddleware(), handleDashboard);

// /service-accounts は SA 監査 dashboard。同じく per-route で CF Access。
app.get("/service-accounts", cfAccessMiddleware(), handleSaDashboard);

app.route("/api", listRoutes);
app.route("/api", inventoryRoutes);
app.route("/api", serviceAccountsRoutes);

export default app;
