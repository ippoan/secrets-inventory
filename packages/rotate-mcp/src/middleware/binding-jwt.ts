import type { Context, MiddlewareHandler } from "hono";
import type { Env, AppVariables } from "../types";

// `Authorization: Bearer <binding_jwt>` を auth-worker (`AUTH_WORKER_ORIGIN`)
// の `POST /mcp/introspect` (Mode 1 — Bearer JWT 自己 introspect) に forward
// して検証する。
//
// Phase A の `ROTATE_MCP_BEARER` (Secrets Store binding + 手動 30 日
// rotation) を置換する (Refs #43)。read MCP 側の `src/middleware/binding-jwt.ts`
// と挙動を一致させており、両 worker の auth 経路を統一する。
//
// rotate-mcp は write 系 (= 3 provider に対する secret 上書き) を持つ高権限
// route だが、本 middleware に到達する前に既存 CF Access (Google OAuth) は
// **edge で bypassAll** に切替えられているため、binding_jwt が唯一の identity
// 境界となる。auth-worker は 24h TTL + per-client (= per github_login) で JWT
// を mint し、revoke も `MCP_OAUTH_KV` 経由で個別に可能。

const SCHEME_PREFIX = "Bearer ";
const DEFAULT_AUTH_WORKER_ORIGIN = "https://auth.ippoan.org";

export interface BindingJwtClaims {
  sub: string;
  github_login: string;
  scope: string;
  exp: number;
}

export interface BindingJwtMiddlewareOptions {
  introspectFetch?: typeof fetch;
  authWorkerOrigin?: string;
  expectedAud?: readonly string[] | null;
}

function wwwAuthenticate(authOrigin: string, error?: string): string {
  const base = `Bearer realm="MCP", resource_metadata="${authOrigin}/.well-known/oauth-protected-resource"`;
  return error ? `${base}, error="${error}"` : base;
}

function unauthorized(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  authOrigin: string,
  errorCode: string,
  message: string,
  status: 401 | 503 = 401,
): Response {
  if (status === 401) {
    c.header("WWW-Authenticate", wwwAuthenticate(authOrigin, errorCode));
  }
  return c.json({ error: message }, status);
}

/**
 * binding_jwt (auth-worker mint) を `/mcp/introspect` 経由で検証する。
 *
 * - header 欠落 / scheme 不正 → 401 + WWW-Authenticate
 * - introspect 503 / fetch 失敗 / 5xx → 503 (fail-closed)
 * - active:false / aud mismatch → 401 + WWW-Authenticate
 * - 成功時は `c.set("bindingJwt", claims)` + `c.set("bearerVerified", true)`
 */
export function bindingJwtMiddleware(
  options: BindingJwtMiddlewareOptions = {},
): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> {
  return async (c, next) => {
    const authOrigin =
      options.authWorkerOrigin ?? c.env.AUTH_WORKER_ORIGIN ?? DEFAULT_AUTH_WORKER_ORIGIN;

    const header = c.req.header("Authorization");
    if (!header || !header.startsWith(SCHEME_PREFIX)) {
      return unauthorized(
        c,
        authOrigin,
        "invalid_token",
        "missing or malformed Authorization: Bearer header",
      );
    }
    const token = header.slice(SCHEME_PREFIX.length);
    if (!token) {
      return unauthorized(c, authOrigin, "invalid_token", "empty bearer token");
    }

    const fetchImpl = options.introspectFetch ?? fetch;
    let resp: Response;
    try {
      resp = await fetchImpl(`${authOrigin}/mcp/introspect`, {
        method: "POST",
        headers: {
          "Authorization": header,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(
        { error: `introspect fetch failed: ${msg}` },
        503,
      );
    }

    if (resp.status === 503) {
      return c.json(
        { error: "auth-worker introspect 503 (server misconfigured)" },
        503,
      );
    }
    if (resp.status === 401) {
      return unauthorized(c, authOrigin, "invalid_token", "invalid bearer token");
    }
    if (!resp.ok) {
      return c.json(
        { error: `introspect failed: HTTP ${resp.status}` },
        503,
      );
    }

    let body: { active?: unknown; scope?: unknown; sub?: unknown;
                github_login?: unknown; exp?: unknown; aud?: unknown };
    try {
      body = (await resp.json()) as typeof body;
    } catch {
      return c.json({ error: "introspect returned invalid JSON" }, 503);
    }

    if (body.active !== true) {
      return unauthorized(c, authOrigin, "invalid_token", "token not active");
    }

    if (
      typeof body.sub !== "string" ||
      typeof body.github_login !== "string" ||
      typeof body.scope !== "string" ||
      typeof body.exp !== "number"
    ) {
      return c.json({ error: "introspect response missing required claims" }, 503);
    }

    if (options.expectedAud && typeof body.aud === "string"
        && !options.expectedAud.includes(body.aud)) {
      return unauthorized(c, authOrigin, "invalid_token", "aud not in allowlist");
    }

    const claims: BindingJwtClaims = {
      sub: body.sub,
      github_login: body.github_login,
      scope: body.scope,
      exp: body.exp,
    };
    c.set("bindingJwt", claims);
    c.set("bearerVerified", true);
    await next();
  };
}
