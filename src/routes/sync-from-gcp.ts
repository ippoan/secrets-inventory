import { Hono } from "hono";
import type { Env } from "../types";
import type { BindingJwtClaims } from "../middleware/binding-jwt";
import {
  gcpProxyCtxFromEnv,
  syncFromGcp,
  type SyncFromGcpTarget,
} from "../providers/gcp";

// `POST /mcp/sync-from-gcp/:name` (Refs ippoan/auth-worker#209 +
// ippoan/secrets-inventory-gcp#34)。
//
// proxy 側 `/sync-from-gcp/{src_name}` を mcp.write 認証 + binding_jwt 経路で
// expose する。値の物理経路:
//
//   GCP Secret Manager → proxy memory → {CF / GitHub} API
//
// worker / 応答 body / log には値が一切 echo されない (= 全部 proxy 内完結)。
// `read_first` の workflows にも mint → sync の 2 段運用として記載する。

const SECRET_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const VALID_TARGETS: SyncFromGcpTarget[] = ["gh", "cf"];
const VALID_VISIBILITY = new Set(["all", "private", "selected"]);

export const syncFromGcpRoutes = new Hono<{
  Bindings: Env;
  Variables: { bindingJwt: BindingJwtClaims };
}>();

syncFromGcpRoutes.post("/mcp/sync-from-gcp/:name", async (c) => {
  const srcName = c.req.param("name");
  if (!SECRET_NAME_PATTERN.test(srcName)) {
    return c.json({ error: "invalid src name (must match SCREAMING_SNAKE / kebab-case)" }, 400);
  }

  const claims = c.get("bindingJwt");
  const jwtScopes = (claims?.scope ?? "").split(/\s+/).filter((s) => s.length > 0);
  if (!jwtScopes.includes("mcp.write")) {
    return c.json(
      {
        error: "missing required scope: mcp.write",
        hint: "obtain a binding_jwt with mcp.write scope from auth.ippoan.org",
      },
      403,
    );
  }

  // query 解釈 — proxy 側に丸投げするのではなく worker でも軽く validate して
  // 4xx を早期に返す (= proxy round-trip / log noise を減らす)。
  const rawTargets = (c.req.query("targets") ?? "").trim();
  if (!rawTargets) {
    return c.json({ error: "targets query is required (gh / cf / gh,cf)" }, 400);
  }
  const targets: SyncFromGcpTarget[] = [];
  for (const t of rawTargets.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
    if (!(VALID_TARGETS as string[]).includes(t)) {
      return c.json({ error: "invalid target (only gh / cf allowed)" }, 400);
    }
    if (!targets.includes(t as SyncFromGcpTarget)) {
      targets.push(t as SyncFromGcpTarget);
    }
  }
  if (targets.length === 0) {
    return c.json({ error: "targets must include at least one of gh,cf" }, 400);
  }

  const ghName = c.req.query("gh_name") || undefined;
  const cfName = c.req.query("cf_name") || undefined;
  if (ghName !== undefined && !SECRET_NAME_PATTERN.test(ghName)) {
    return c.json({ error: "invalid gh_name" }, 400);
  }
  if (cfName !== undefined && !SECRET_NAME_PATTERN.test(cfName)) {
    return c.json({ error: "invalid cf_name" }, 400);
  }

  const visibilityRaw = c.req.query("visibility");
  if (visibilityRaw !== undefined && !VALID_VISIBILITY.has(visibilityRaw)) {
    return c.json({ error: "invalid visibility (use all / private / selected)" }, 400);
  }
  const visibility = visibilityRaw as "all" | "private" | "selected" | undefined;

  const scopesRaw = c.req.query("scopes");
  const scopes = scopesRaw
    ? scopesRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;

  let failIfExists: boolean | undefined;
  const failRaw = (c.req.query("fail_if_exists") ?? "").toLowerCase();
  switch (failRaw) {
    case "":
      failIfExists = undefined; // proxy default (= true)
      break;
    case "true":
    case "1":
    case "yes":
      failIfExists = true;
      break;
    case "false":
    case "0":
    case "no":
      failIfExists = false;
      break;
    default:
      return c.json({ error: "invalid fail_if_exists (use true / false)" }, 400);
  }

  const actorEmail = claims?.github_login ?? undefined;
  const ctx = await gcpProxyCtxFromEnv(c.env, actorEmail);
  const result = await syncFromGcp(
    {
      srcName,
      targets,
      ghName,
      cfName,
      visibility,
      scopes,
      failIfExists,
    },
    ctx,
  );
  return c.json(result, result.status === "ok" ? 200 : 502);
});
