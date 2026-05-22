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

/** GET /service-accounts — HTML dashboard。`?status=candidate|warn|ok` で filter。 */
export async function handleSaDashboard(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  const statusQ = c.req.query("status");
  const filter = parseStatusFilter(statusQ);
  try {
    const result = await gatherSaInventory(c.env);
    return c.html(renderSaInventoryPage(result, { filter }));
  } catch (err) {
    if (err instanceof GcpIamUnavailableError) {
      return c.html(
        renderErrorPage(`GCP IAM proxy unavailable: ${err.message}`),
        502,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? `\n\n${err.stack}` : "";
    console.error("SA dashboard handler error:", err);
    return c.html(
      renderErrorPage(`Unexpected error: ${message}${stack}`),
      500,
    );
  }
}

function parseStatusFilter(s: string | undefined): SaStatus | undefined {
  if (s === "candidate" || s === "warn" || s === "ok") return s;
  return undefined;
}
