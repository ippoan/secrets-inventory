import { Hono } from "hono";
import type { Env, ProviderListError, ProviderListResult } from "../types";
import { listCloudflareSecrets } from "../providers/cloudflare";
import { listGitHubOrgSecrets } from "../providers/github";
import { listGcpSecrets } from "../providers/gcp";
import type { CfAccessClaims } from "../middleware/cf-access";

type AppVariables = { cfAccess: CfAccessClaims };

export const listRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/** GET /api/cloudflare/secrets — CF Secrets Store のメタデータ一覧 */
listRoutes.get("/cloudflare/secrets", async (c) => {
  const token = await c.env.CF_API_TOKEN.get();
  const result = await listCloudflareSecrets({
    token,
    accountId: c.env.CF_ACCOUNT_ID,
    storeId: c.env.CF_STORE_ID,
  });
  return c.json({ provider: "cloudflare", secrets: result } satisfies ProviderListResult);
});

/** GET /api/github/secrets — GitHub org Actions secrets のメタデータ一覧 */
listRoutes.get("/github/secrets", async (c) => {
  const token = await c.env.GITHUB_PAT.get();
  const result = await listGitHubOrgSecrets({
    token,
    org: c.env.GITHUB_ORG,
  });
  return c.json({ provider: "github", secrets: result } satisfies ProviderListResult);
});

/** GET /api/gcp/secrets — Cloud Run proxy (secrets-inventory-gcp) 経由で GCP Secret Manager メタデータを取得 */
listRoutes.get("/gcp/secrets", async (c) => {
  const apiKey = await c.env.GCP_PROXY_API_KEY.get();
  const result = await listGcpSecrets({
    proxyUrl: c.env.GCP_PROXY_URL,
    apiKey,
  });
  return c.json({ provider: "gcp", secrets: result } satisfies ProviderListResult);
});

/**
 * GET /api/all — 3 プロバイダーを並列に叩いて 1 つにまとめる。
 * いずれかが落ちても他は返す (partial success)。
 */
listRoutes.get("/all", async (c) => {
  const [cf, gh, gcp] = await Promise.allSettled([
    (async () => {
      const token = await c.env.CF_API_TOKEN.get();
      return listCloudflareSecrets({
        token,
        accountId: c.env.CF_ACCOUNT_ID,
        storeId: c.env.CF_STORE_ID,
      });
    })(),
    (async () => {
      const token = await c.env.GITHUB_PAT.get();
      return listGitHubOrgSecrets({ token, org: c.env.GITHUB_ORG });
    })(),
    (async () => {
      const apiKey = await c.env.GCP_PROXY_API_KEY.get();
      return listGcpSecrets({
        proxyUrl: c.env.GCP_PROXY_URL,
        apiKey,
      });
    })(),
  ]);

  const body = {
    cloudflare: settledToBody("cloudflare", cf),
    github: settledToBody("github", gh),
    gcp: settledToBody("gcp", gcp),
  };
  return c.json(body);
});

function settledToBody<P extends ProviderListResult["provider"]>(
  provider: P,
  s: PromiseSettledResult<import("../types").SecretMetadata[]>,
): ProviderListResult | ProviderListError {
  if (s.status === "fulfilled") {
    return { provider, secrets: s.value };
  }
  const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
  return { provider, error: reason };
}
