import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import { gatherSaInventory, GcpIamUnavailableError } from "../sa-inventory";
import { renderSaInventoryPage } from "../sa-ui";
import { renderErrorPage } from "../ui";
import type { SaStatus } from "../audit/sa-flags";

export const serviceAccountsRoutes = new Hono<{ Bindings: Env }>();

/** GET /api/service-accounts — JSON 形式の SA inventory。 */
serviceAccountsRoutes.get("/service-accounts", async (c) => {
  try {
    const result = await gatherSaInventory(c.env);
    return c.json(result);
  } catch (err) {
    if (err instanceof GcpIamUnavailableError) {
      return c.json(
        { error: `GCP IAM proxy unavailable: ${err.message}` },
        502,
      );
    }
    throw err;
  }
});

/**
 * GET /service-accounts — SA 監査 dashboard。
 *
 * - `?status=candidate|warn|ok` で row を絞り込む (HTML レンダリング時のみ)
 * - `?format=json` で `/api/service-accounts` と同じ JSON shape を返す
 *   (browser の URL bar から開いて差分確認、curl から叩いて diff、
 *   `gatherSaInventory` の raw output をそのまま CLI で扱う等の用途。
 *   `/api/...` は CF Access 後段で同じ JSON を返すが、URL を 2 系統で
 *   覚えるより 1 系統 + クエリの方が運用が楽だという判断)
 *
 * Default は従来通り HTML。
 */
export async function handleSaDashboard(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  const wantsJson = c.req.query("format") === "json";
  const filter = parseStatusFilter(c.req.query("status"));
  try {
    const result = await gatherSaInventory(c.env);
    if (wantsJson) {
      return c.json(result);
    }
    return c.html(renderSaInventoryPage(result, { filter }));
  } catch (err) {
    if (err instanceof GcpIamUnavailableError) {
      const detail = `GCP IAM proxy unavailable: ${err.message}`;
      return wantsJson
        ? c.json({ error: detail }, 502)
        : c.html(renderErrorPage(detail), 502);
    }
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? `\n\n${err.stack}` : "";
    console.error("SA dashboard handler error:", err);
    return wantsJson
      ? c.json({ error: `Unexpected error: ${message}` }, 500)
      : c.html(renderErrorPage(`Unexpected error: ${message}${stack}`), 500);
  }
}

function parseStatusFilter(s: string | undefined): SaStatus | undefined {
  if (s === "candidate" || s === "warn" || s === "ok") return s;
  return undefined;
}
