import { Hono } from "hono";
import type { Env } from "../types";
import type { BindingJwtClaims } from "../middleware/binding-jwt";
import {
  convertPkcs8,
  gcpProxyCtxFromEnv,
  type ConvertPkcs8Target,
} from "../providers/gcp";

// `POST /mcp/convert-pkcs8/:name?dst_name=...&targets=gcp,gh&gh_name=...`
// (Refs ippoan/secrets-inventory#59)
//
// proxy 側 `/convert-pkcs8/{src}` を mcp.write 認証 + binding_jwt 経路で expose。
// GCP の RSA 秘密鍵 (PKCS#1) を PKCS#8 に変換し、別名 dst_name で保存 + 任意で
// GitHub propagate。値は proxy 内完結で worker / 応答 / log に載らない。

const SECRET_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const VALID_TARGETS: ConvertPkcs8Target[] = ["gcp", "gh"];

export const convertPkcs8Routes = new Hono<{
  Bindings: Env;
  Variables: { bindingJwt: BindingJwtClaims };
}>();

convertPkcs8Routes.post("/mcp/convert-pkcs8/:name", async (c) => {
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

  const dstName = c.req.query("dst_name") || "";
  if (!SECRET_NAME_PATTERN.test(dstName)) {
    return c.json({ error: "dst_name query is required and must match the name pattern" }, 400);
  }
  if (dstName === srcName) {
    return c.json({ error: "dst_name must differ from src (keep the PKCS#1 original intact)" }, 400);
  }

  // targets: 省略時 proxy default (= gcp)。指定時は worker でも軽く validate。
  const rawTargets = (c.req.query("targets") ?? "").trim();
  let targets: ConvertPkcs8Target[] | undefined;
  if (rawTargets) {
    targets = [];
    for (const t of rawTargets.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
      if (!(VALID_TARGETS as string[]).includes(t)) {
        return c.json({ error: "invalid target (only gcp / gh allowed)" }, 400);
      }
      if (!targets.includes(t as ConvertPkcs8Target)) {
        targets.push(t as ConvertPkcs8Target);
      }
    }
    if (!targets.includes("gcp")) {
      return c.json({ error: "targets must include gcp" }, 400);
    }
  }

  const ghName = c.req.query("gh_name") || undefined;
  if (ghName !== undefined && !SECRET_NAME_PATTERN.test(ghName)) {
    return c.json({ error: "invalid gh_name" }, 400);
  }

  const actorEmail = claims?.github_login ?? undefined;
  const ctx = await gcpProxyCtxFromEnv(c.env, actorEmail);
  const result = await convertPkcs8({ srcName, dstName, targets, ghName }, ctx);
  return c.json(result, result.status === "ok" ? 200 : 502);
});
