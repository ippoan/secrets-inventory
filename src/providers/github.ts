import type { Env, SecretMetadata } from "../types";

// GitHub Actions org secrets provider。
//
// **Refs #45** 以前は worker が GitHub PAT (`env.GITHUB_PAT`) を Secrets Store
// binding 経由で持ち、`api.github.com` を直接叩き、tweetnacl で libsodium
// sealed box を pure-JS で再現していた。Stage 2 で「worker は GCP proxy 経由
// でしか外部に出ない」ポリシーに統一したため、本 module は **`secrets-
// inventory-gcp` Cloud Run proxy 経由**に書き換わった。
//
// proxy endpoint (= ippoan/secrets-inventory-gcp#25 で追加):
//   - GET /gh/secrets         → list
//   - PUT /gh/secrets/{name}  → write (proxy 側で sealed box encrypt + PUT)
//
// libsodium 依存も proxy 側 (Go `golang.org/x/crypto/nacl/box`) に移動。
// worker は素の value を JSON で送るだけで encrypt は意識しない。

export class GithubProxyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GithubProxyError";
  }
}

export interface GhProxyContext {
  proxyUrl: string;
  apiKey: string;
  /** 操作者 email (actor audit log 用)。read 経路では未使用。 */
  actorEmail?: string;
}

interface GhRawSecret {
  name: string;
  created_at: string;
  updated_at: string;
  visibility?: string;
}

interface GhListResponse {
  secrets?: GhRawSecret[];
}

/**
 * proxy 経由で GitHub org secrets list を取得。値は API がそもそも返さない。
 */
export async function listGitHubOrgSecrets(
  ctx: GhProxyContext,
): Promise<SecretMetadata[]> {
  const res = await fetch(`${ctx.proxyUrl}/gh/secrets`, {
    method: "GET",
    headers: {
      "X-Inventory-API-Key": ctx.apiKey,
      Accept: "application/json",
      "User-Agent": "secrets-inventory",
    },
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new GithubProxyError(res.status, `GH proxy ${res.status}: ${body}`);
  }
  const raw = (await res.json()) as GhListResponse;
  return (raw.secrets ?? []).map((s) => ({
    name: s.name,
    created_at: s.created_at,
    updated_at: s.updated_at,
    extra: {
      visibility: s.visibility ?? null,
    },
  }));
}

// ===========================================================================
// write 系 (= 旧 packages/rotate-mcp の rotateGithub / createGithub を
// proxy 経由に書き換えたもの)
// ===========================================================================

export interface GhRotateArgs {
  name: string;
  newValue: string;
  /** GitHub Actions secret の visibility (default = "all")。 */
  visibility?: "all" | "private" | "selected";
}

export interface GhRotateResult {
  status: "ok" | "fail";
  error?: string;
}

/**
 * 既存 secret の値を更新。GitHub の `PUT /orgs/{org}/actions/secrets/{name}`
 * は冪等 (create + update 兼用) なので、`failIfExists` を立てなければ proxy が
 * 即 PUT する (= existence check 不要)。
 *
 * 失敗は status="fail" で返し throw しない (= 並列実行で他 provider を巻き込まない)。
 */
export async function rotateGithub(
  args: GhRotateArgs,
  ctx: GhProxyContext,
): Promise<GhRotateResult> {
  let res: Response;
  try {
    res = await fetch(
      `${ctx.proxyUrl}/gh/secrets/${encodeURIComponent(args.name)}`,
      {
        method: "PUT",
        headers: proxyHeaders(ctx, false),
        body: JSON.stringify({
          value: args.newValue,
          ...(args.visibility ? { visibility: args.visibility } : {}),
        }),
      },
    );
  } catch (err) {
    return {
      status: "fail",
      error: `gh proxy network: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    return { status: "fail", error: `gh proxy ${res.status}: ${body}` };
  }
  return { status: "ok" };
}

export interface GhCreateArgs {
  name: string;
  initialValue: string;
  /** true (default) で既存衝突は 409。false で冪等上書き (= rotate 相当)。 */
  failIfExists?: boolean;
  visibility?: "all" | "private" | "selected";
}

export interface GhCreateResult extends GhRotateResult {
  /** 新規作成 = true、既存上書き = false (fail_if_exists=false 時)。 */
  created?: boolean;
}

/**
 * 新規 secret 作成。`X-Fail-If-Exists` header を proxy に渡して existence
 * check + 409 を proxy 側に委譲する (= worker は判定ロジックを持たない)。
 */
export async function createGithub(
  args: GhCreateArgs,
  ctx: GhProxyContext,
): Promise<GhCreateResult> {
  const failIfExists = args.failIfExists ?? true;
  let res: Response;
  try {
    res = await fetch(
      `${ctx.proxyUrl}/gh/secrets/${encodeURIComponent(args.name)}`,
      {
        method: "PUT",
        headers: proxyHeaders(ctx, failIfExists),
        body: JSON.stringify({
          value: args.initialValue,
          ...(args.visibility ? { visibility: args.visibility } : {}),
        }),
      },
    );
  } catch (err) {
    return {
      status: "fail",
      error: `gh proxy network: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (res.status === 409) {
    return { status: "fail", error: "github secret already exists" };
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    return { status: "fail", error: `gh proxy ${res.status}: ${body}` };
  }
  let parsed: { ok?: boolean; created?: boolean };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch (err) {
    return {
      status: "fail",
      error: `gh proxy bad json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!parsed.ok) {
    return { status: "fail", error: "gh proxy returned ok=false" };
  }
  return { status: "ok", created: parsed.created === true };
}

// ===========================================================================
// GitHub Actions **repo variables** (平文 config、secret ではない)。
// proxy endpoint (ippoan/secrets-inventory-gcp の /gh/variables):
//   - GET /gh/variables?repo=owner/name        → list (value 含む)
//   - PUT /gh/variables/{name}?repo=owner/name → upsert (proxy が GET→POST/PATCH)
// secret と違い sealed box 暗号化はしない (平文)。
// ===========================================================================

export interface GhRepoVariable {
  name: string;
  value: string;
  created_at: string;
  updated_at: string;
}

interface GhVariablesListResponse {
  variables?: GhRepoVariable[];
}

/** repo の Actions variables を list (value 含む = 平文 config なので隠さない)。 */
export async function listGitHubRepoVariables(
  repo: string,
  ctx: GhProxyContext,
): Promise<GhRepoVariable[]> {
  const res = await fetch(
    `${ctx.proxyUrl}/gh/variables?repo=${encodeURIComponent(repo)}`,
    {
      method: "GET",
      headers: {
        "X-Inventory-API-Key": ctx.apiKey,
        Accept: "application/json",
        "User-Agent": "secrets-inventory",
      },
    },
  );
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new GithubProxyError(res.status, `GH proxy ${res.status}: ${body}`);
  }
  const raw = (await res.json()) as GhVariablesListResponse;
  return raw.variables ?? [];
}

export interface GhSetVariableArgs {
  repo: string;
  name: string;
  value: string;
}

export interface GhSetVariableResult {
  status: "ok" | "fail";
  /** 新規作成 = true、既存更新 = false (proxy の事前 GET 判定に基づく)。 */
  created?: boolean;
  error?: string;
}

/**
 * repo Actions variable を upsert する。proxy が事前 GET で存在判定し、無ければ
 * POST (create) / 有れば PATCH (update) する。失敗は status="fail" で返し throw
 * しない (rotate/create と同じ規約)。
 */
export async function setGitHubRepoVariable(
  args: GhSetVariableArgs,
  ctx: GhProxyContext,
): Promise<GhSetVariableResult> {
  let res: Response;
  try {
    res = await fetch(
      `${ctx.proxyUrl}/gh/variables/${encodeURIComponent(args.name)}?repo=${encodeURIComponent(args.repo)}`,
      {
        method: "PUT",
        headers: proxyHeaders(ctx, false),
        body: JSON.stringify({ value: args.value }),
      },
    );
  } catch (err) {
    return {
      status: "fail",
      error: `gh proxy network: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    return { status: "fail", error: `gh proxy ${res.status}: ${body}` };
  }
  let parsed: { ok?: boolean; created?: boolean };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch (err) {
    return {
      status: "fail",
      error: `gh proxy bad json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!parsed.ok) {
    return { status: "fail", error: "gh proxy returned ok=false" };
  }
  return { status: "ok", created: parsed.created === true };
}

function proxyHeaders(ctx: GhProxyContext, failIfExists: boolean): Record<string, string> {
  const h: Record<string, string> = {
    "X-Inventory-API-Key": ctx.apiKey,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "secrets-inventory",
  };
  if (ctx.actorEmail) h["X-Actor-Email"] = ctx.actorEmail;
  if (failIfExists) h["X-Fail-If-Exists"] = "true";
  return h;
}

/** Env から proxy ctx を組み立てる helper。 */
export async function ghProxyCtxFromEnv(
  env: Env,
  actorEmail?: string,
): Promise<GhProxyContext> {
  const apiKey = await env.GCP_PROXY_API_KEY.get();
  return { proxyUrl: env.GCP_PROXY_URL, apiKey, actorEmail };
}
