import { Hono } from "hono";
import type { Env } from "../types";
import type { BindingJwtClaims } from "../middleware/binding-jwt";
import { gcpProxyCtxFromEnv, mintHealthOAuthJwt } from "../providers/gcp";

// `POST /mcp/mint-health-oauth-jwt` (Refs ippoan/auth-worker#209)
//
// Worker は薄い proxy として Cloud Run 側の `/mint-health-oauth-jwt` を呼ぶ。
// 実際の JWT 生成 (JWT_SECRET 読み出し + HS256 sign + GCP Secret Manager 書き込み)
// は全部 Cloud Run proxy 内で完結し、worker / response body / log にも値は
// 一切 echo されない。
//
// 認証:
//   - `/mcp/*` 共通の bindingJwtMiddleware で binding_jwt が attached 済み
//   - 本 route で `mcp.write` scope を再 check (= 値 mutation を伴うため)
//
// Body 不要 (proxy 側で payload claims 含めて hardcode)。

export const mintHealthOAuthJwtRoutes = new Hono<{
  Bindings: Env;
  Variables: { bindingJwt: BindingJwtClaims };
}>();

mintHealthOAuthJwtRoutes.post("/mcp/mint-health-oauth-jwt", async (c) => {
  const claims = c.get("bindingJwt");
  const scopes = (claims?.scope ?? "").split(/\s+/).filter((s) => s.length > 0);
  if (!scopes.includes("mcp.write")) {
    return c.json(
      {
        error: "missing required scope: mcp.write",
        hint: "obtain a binding_jwt with mcp.write scope from auth.ippoan.org",
      },
      403,
    );
  }

  const actorEmail = claims?.github_login ?? undefined;
  const ctx = await gcpProxyCtxFromEnv(c.env, actorEmail);
  const result = await mintHealthOAuthJwt(ctx);
  return c.json(result, result.status === "ok" ? 200 : 502);
});
