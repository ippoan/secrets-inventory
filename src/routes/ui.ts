import { Hono } from "hono";
import type { Env } from "../types";
import { gatherInventory, GcpUnavailableError } from "../inventory";
import { renderInventoryPage, renderErrorPage } from "../ui";

export const uiRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /ui — Cloudflare Access 経由でアクセスする突合 dashboard。
 * `?commit=1` で snapshot 更新も同 endpoint 上で行う。
 */
uiRoutes.get("/", async (c) => {
  const commit = c.req.query("commit") === "1";
  try {
    const result = await gatherInventory(c.env, { commitSnapshot: commit });
    return c.html(renderInventoryPage(result));
  } catch (err) {
    if (err instanceof GcpUnavailableError) {
      return c.html(renderErrorPage(`GCP fetch failed: ${err.message}`), 502);
    }
    throw err;
  }
});
