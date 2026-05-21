import type { Context } from "hono";
import type { Env } from "../types";
import { gatherInventory, GcpUnavailableError } from "../inventory";
import { renderInventoryPage, renderErrorPage } from "../ui";

/**
 * 突合 dashboard handler。本 Worker のルート (`/`) に直接マウントされる前提で、
 * Cloudflare Access middleware の後段で動く。`?commit=1` で snapshot 更新も
 * 同 endpoint 上で行う。
 */
export async function handleDashboard(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
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
}
