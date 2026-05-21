import type { Context } from "hono";
import type { Env } from "../types";
import { gatherInventory, GcpUnavailableError } from "../inventory";
import { renderInventoryPage, renderErrorPage } from "../ui";

/**
 * 突合 dashboard handler。本 Worker のルート (`/`) に直接マウントされる前提で、
 * Cloudflare Access middleware の後段で動く。`?commit=1` で snapshot 更新も
 * 同 endpoint 上で行う。
 *
 * 例外は generic な Hono 500 (本文 "Internal Server Error") にせず、HTML
 * エラーページに stack trace を載せて返す。CF Access の後ろに居る前提なので
 * 操作者にしか見えず、原因切り分けが速い (worker logs に出る前にブラウザで
 * 見える)。GCP 失敗だけは 502 で区別。
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
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? `\n\n${err.stack}` : "";
    console.error("dashboard handler error:", err);
    return c.html(
      renderErrorPage(`Unexpected error: ${message}${stack}`),
      500,
    );
  }
}
