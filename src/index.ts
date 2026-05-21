import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { cfAccessMiddleware, type CfAccessClaims } from "./middleware/cf-access";
import { listRoutes } from "./routes/list";

type AppVariables = { cfAccess: CfAccessClaims };

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use("*", cors());

// /healthz は Cloudflare Access の前段でも通したいので middleware より先に置く
app.get("/healthz", (c) =>
  c.json({ ok: true, service: "secrets-inventory" }),
);

// 全ての /api/* は Cloudflare Access (Google OAuth) 必須
app.use("/api/*", cfAccessMiddleware());

app.get("/", (c) =>
  c.text(
    "secrets-inventory — GET /api/* (Cloudflare Access required). See https://github.com/ippoan/secrets-inventory.",
  ),
);

app.route("/api", listRoutes);

export default app;
