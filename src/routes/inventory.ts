import { Hono } from "hono";
import type { Env } from "../types";
import { gatherInventory, GcpUnavailableError } from "../inventory";

export const inventoryRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/inventory — 突合 + 前回 snapshot との diff を JSON で返す。
 * `?commit=1` を付けると今回の GCP 名一覧で snapshot を上書きする。
 */
inventoryRoutes.get("/inventory", async (c) => {
  const commit = c.req.query("commit") === "1";
  try {
    const result = await gatherInventory(c.env, { commitSnapshot: commit });
    return c.json(result);
  } catch (err) {
    if (err instanceof GcpUnavailableError) {
      return c.json(
        {
          error: `GCP fetch failed (source of truth unavailable): ${err.message}`,
        },
        502,
      );
    }
    throw err;
  }
});
