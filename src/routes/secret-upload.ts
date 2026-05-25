import { Hono } from "hono";
import type { Env } from "../types";
import type { BindingJwtClaims } from "../middleware/binding-jwt";
import {
  executeCreate,
  NAME_PATTERN,
  ROTATION_TARGETS,
  TARGETS_MUST_INCLUDE_GCP_MESSAGE,
  targetsIncludeGcp,
  type RotationTarget,
} from "../mcp/tools/create-secret";
import { executeRotate } from "../mcp/tools/rotate-secret";

// `PUT /mcp/secret-upload/:name` — HTTP body 経由で value を受け取り
// `create_secret` / `rotate_secret` と同じ実行経路に流し込む route。
//
// 動機: MCP の JSON-RPC `tools/call` で `initial_value` / `new_value` を
// parameter として渡すと、その値が LLM agent の tool-call payload (= LLM
// context) に乗ってしまう。base64 keystore のような秘密値をその経路に流すと
// chat transcript / log への露出が避けられない。
//
// そこで `mcp.write` scope を持つ binding_jwt を `Authorization: Bearer` で
// 提示しつつ、value 自体は HTTP body (raw bytes、`--data-binary @file` で
// 直接流せる) で送る代替経路を提供する。auth は MCP route 群と同じ
// `bindingJwtMiddleware` で、CF Access も `/mcp/*` の bypassAll 設定が
// そのまま効く。
//
// agent 利用例:
//
//   curl -X PUT \
//     'https://security-inventory.ippoan.org/mcp/secret-upload/HCREADER_RELEASE_KEY?targets=github&fail_if_exists=true' \
//     -H "Authorization: Bearer $MCP_JWT" \
//     --data-binary @/tmp/keystore_b64
//
// 値は shell 変数 → curl body → worker memory → 既存 executeCreate
// (= proxy `POST /create-secret`) → GCP Secret Manager の経路で流れ、
// LLM の tool-call JSON parameter には載らない。
//
// Query parameters:
//   - mode = create (default) | rotate
//   - targets = gcp,cf,github (comma-separated、省略時は 3 つ全部)
//   - fail_if_exists = true (default) | false [create のみ]
//   - cf_scopes = workers (comma-separated、CF target で意味あり) [create のみ]
//   - expected_gcp_version_id = <id> [rotate のみ、TOCTOU 検証]
//
// Body: raw bytes (UTF-8 string、最大 65536 bytes = MCP schema 上限と一致)。

const MAX_BODY_BYTES = 65536;

export const secretUploadRoutes = new Hono<{
  Bindings: Env;
  Variables: { bindingJwt: BindingJwtClaims };
}>();

function unauthorizedForScope(): Response {
  return Response.json(
    {
      error: "missing required scope: mcp.write",
      hint: "obtain a binding_jwt with mcp.write scope from auth.ippoan.org",
    },
    { status: 403 },
  );
}

function parseTargets(raw: string | undefined): RotationTarget[] | null {
  if (!raw) return [...ROTATION_TARGETS];
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const out: RotationTarget[] = [];
  for (const p of parts) {
    if (!(ROTATION_TARGETS as readonly string[]).includes(p)) return null;
    out.push(p as RotationTarget);
  }
  return out;
}

function parseBool(
  raw: string | undefined,
  def: boolean,
): boolean | "invalid" {
  if (raw === undefined) return def;
  switch (raw.toLowerCase()) {
    case "true":
    case "1":
    case "yes":
      return true;
    case "false":
    case "0":
    case "no":
      return false;
    default:
      return "invalid";
  }
}

function parseCsv(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const arr = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return arr.length > 0 ? arr : undefined;
}

secretUploadRoutes.put("/mcp/secret-upload/:name", async (c) => {
  const name = c.req.param("name");
  if (!NAME_PATTERN.test(name)) {
    return c.json({ error: "invalid name (must match SCREAMING_SNAKE / kebab-case)" }, 400);
  }

  // binding_jwt 経由で attach 済の scope を確認。mcp.write 必須。
  const claims = c.get("bindingJwt");
  const scopes = (claims?.scope ?? "").split(/\s+/).filter((s) => s.length > 0);
  if (!scopes.includes("mcp.write")) {
    return unauthorizedForScope();
  }

  // Content-Length で fast-reject (body 読み込み前に大きすぎる payload を止める)
  const cl = c.req.header("Content-Length");
  if (cl !== undefined) {
    const len = Number.parseInt(cl, 10);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
      return c.json({ error: "value too large" }, 413);
    }
  }

  const value = await c.req.text();
  if (value.length === 0) {
    return c.json({ error: "value is required (empty body)" }, 400);
  }
  if (value.length > MAX_BODY_BYTES) {
    return c.json({ error: "value too large" }, 413);
  }

  const mode = c.req.query("mode") ?? "create";
  if (mode !== "create" && mode !== "rotate") {
    return c.json({ error: "invalid mode (use 'create' or 'rotate')" }, 400);
  }

  const targets = parseTargets(c.req.query("targets"));
  if (targets === null) {
    return c.json(
      { error: "invalid targets (use comma-separated subset of gcp,cf,github)" },
      400,
    );
  }
  // GCP は source of truth。`targets` から外すと inventory drift 検出が
  // 機能しなくなる (= GH/CF にだけ存在する orphan secret が出る) ため
  // ここで強制 reject する。CLAUDE.md「GCP が正 (source of truth)」参照。
  if (!targetsIncludeGcp(targets)) {
    return c.json({ error: TARGETS_MUST_INCLUDE_GCP_MESSAGE }, 400);
  }

  // actorEmail は audit log 用。binding_jwt の github_login を渡す
  // (= github_login @users.noreply.github.com 形式は CLAUDE.md の actor
  // 規約だが、ここでは login をそのまま渡しても proxy 側の log で識別可能)。
  const actorEmail = claims?.github_login ?? undefined;

  if (mode === "create") {
    const failIfExists = parseBool(c.req.query("fail_if_exists"), true);
    if (failIfExists === "invalid") {
      return c.json({ error: "invalid fail_if_exists (use 'true'/'false')" }, 400);
    }
    const cfScopes = parseCsv(c.req.query("cf_scopes"));
    const result = await executeCreate(
      c.env,
      {
        name,
        initial_value: value,
        targets,
        fail_if_exists: failIfExists,
        cf_scopes: cfScopes,
      },
      actorEmail,
    );
    return c.json(result, result.ok ? 200 : 502);
  }

  // mode === "rotate"
  const expectedVersionId = c.req.query("expected_gcp_version_id");
  const result = await executeRotate(
    c.env,
    {
      name,
      new_value: value,
      targets,
      expected_gcp_version_id: expectedVersionId,
    },
    actorEmail,
  );
  return c.json(result, result.ok ? 200 : 502);
});
