// `Authorization: Bearer <binding_jwt>` を auth-worker (`AUTH_WORKER_ORIGIN`)
// の `POST /mcp/introspect` (Mode 1 — Bearer JWT 自己 introspect) に forward
// して検証する。
//
// 検証ロジック本体は `@ippoan/mcp-cf-workers` の `./auth` export に昇格済み
// (Refs ippoan/mcp-cf-workers#46 — 本 file が examples/cf-access-mcp と 175 行
// 重複していた middleware の集約先)。ここは **slug (`security-inventory`) を
// pre-bind する薄い adapter** のみ。
//
// binding_jwt は auth-worker の `/mcp/pair/grant-via-oat` などで mint され、
// HS256 で `MCP_JWT_SECRET` 署名 + `aud=github-mcp-server-rs` を持つ短命
// (24h) JWT。利点 (Refs #43): MCP 標準 OAuth 2.1 (WWW-Authenticate での
// auto-discovery) / per-client revoke / worker 側 provisioning ゼロ。
//
// confused-deputy 考察: binding_jwt の aud は `github-mcp-server-rs` (現状の
// 唯一の allowlist 値) で、secrets-inventory MCP が同 aud の JWT を受理する
// のは MCP spec 2025-06-18 の confused-deputy 要件に厳密には反する。が、
// 本 worker は CF Access (operator 人間判定) の **上に** 載る tool-call 単位
// 認証で、JWT の sub / scope は audit log + per-client identity のみに使う
// (= 別の privilege 境界を提供しているわけではない)。将来 auth-worker 側で
// `secrets-inventory-mcp` aud を allowlist に追加した時点で aud check を
// strict にする (`expectedAud` option を活かす)。
import type { MiddlewareHandler } from "hono";
import {
  introspectBindingJwt,
  BindingJwtError,
  DEFAULT_AUTH_WORKER_ORIGIN,
  wwwAuthenticate as libWwwAuthenticate,
  type BindingJwtClaims,
  type IntrospectBindingJwtOptions,
} from "@ippoan/mcp-cf-workers/auth";
import { bindingJwtMiddleware as libBindingJwtMiddleware } from "@ippoan/mcp-cf-workers/auth/binding-jwt-hono";
import type { Env } from "../types";

// 本 worker (`security-inventory.ippoan.org`) は MCP relay (`mcp(-staging).ippoan.org`)
// とは別の独立 RS なので、auth-worker の per-resource metadata endpoint
// (`/.well-known/oauth-protected-resource/security-inventory`) を指す。
// slug は allowlist 内 URL の hostname 先頭 label と一致させる規約
// (Refs ippoan/auth-worker#195、配線ミスの経緯は #45)。
const RESOURCE_METADATA_SLUG = "security-inventory";

export { introspectBindingJwt, BindingJwtError, DEFAULT_AUTH_WORKER_ORIGIN };
export type { BindingJwtClaims };
export type BindingJwtMiddlewareOptions = IntrospectBindingJwtOptions;

/** 本 worker の slug を pre-bind した WWW-Authenticate 文字列 (RFC 6750 + 9728)。 */
export function wwwAuthenticate(authOrigin: string, error?: string): string {
  return libWwwAuthenticate(authOrigin, RESOURCE_METADATA_SLUG, error);
}

/**
 * binding_jwt (auth-worker mint) を `/mcp/introspect` 経由で検証する Hono
 * middleware。lib の hono adapter に slug を pre-bind しただけ。
 * 成功時は `c.set("bindingJwt", { sub, github_login, scope, exp })`。
 */
export function bindingJwtMiddleware(
  options: BindingJwtMiddlewareOptions = {},
): MiddlewareHandler<{
  Bindings: Env;
  Variables: { bindingJwt: BindingJwtClaims };
}> {
  return libBindingJwtMiddleware<Env>({
    resourceMetadataSlug: RESOURCE_METADATA_SLUG,
    ...options,
  });
}
