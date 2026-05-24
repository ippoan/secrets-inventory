import {
  JSON_RPC_INVALID_PARAMS,
  makeError,
  type JsonRpcError,
} from "../jsonrpc";
import type {
  Env,
  RotateSecretArgs,
  RotateSecretResult,
  RotateSecretProviderResult,
  RotationTarget,
} from "../../types";
import { rotateGcp } from "../../providers/gcp";
import { rotateCloudflare } from "../../providers/cloudflare";
import { rotateGithub } from "../../providers/github";

// MCP tool 定義 (tools/list で expose する schema)。issue #18 の draft schema と
// 揃える。Phase B から実 write 接続 (3 provider) を持つ。
//
// name pattern を Phase B で relax:
//   旧 `^[A-Z][A-Z0-9_]{0,127}$` (SCREAMING_SNAKE 専用) → 新 kebab も許容。
// 親 repo の secrets.required は kebab-case (例 `cf-secrets-inventory-secrets-
// store-read`) で運用されているため、SCREAMING_SNAKE 専用だと現存 secret を
// rotate できなかった。GitHub Actions secrets は SCREAMING_SNAKE 強制だが
// それは GitHub provider が PUT 時に GitHub API 側 422 として弾く前提。

const NAME_PATTERN = "^[A-Za-z][A-Za-z0-9_-]{0,127}$";
const TARGETS_DEFAULT: RotationTarget[] = ["gcp", "cf", "github"];

export const rotateSecretTool = {
  name: "rotate_secret",
  description:
    "GCP Secret Manager を source of truth として、新値を 3 system に投入。" +
    "type-to-confirm / value preview / TOCTOU 検証込み。" +
    "Phase B: 実 write 接続 (GCP proxy / CF API / GitHub libsodium)。",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        pattern: NAME_PATTERN,
        description: "secret 名 (SCREAMING_SNAKE / kebab-case、先頭は英字)",
      },
      new_value: {
        type: "string",
        minLength: 1,
        maxLength: 65536,
        description: "新しい値。response / log に echo されない。",
      },
      targets: {
        type: "array",
        items: { enum: TARGETS_DEFAULT },
        default: TARGETS_DEFAULT,
        description: "更新対象 provider 群。省略時は 3 system すべて。",
      },
      confirm_name: {
        type: "string",
        description: "type-to-confirm: name と一致する文字列。不一致なら 400。",
      },
      expected_gcp_version_id: {
        type: "string",
        description:
          "TOCTOU 検証用。指定すると GCP 側 version_id がこれと一致する時のみ更新。",
      },
    },
    required: ["name", "new_value", "confirm_name"],
    additionalProperties: false,
  },
} as const;

export const dryRunRotateTool = {
  name: "dry_run_rotate",
  description:
    "実 write はせず、どの provider に何が起きるかを返す。AI が確認 prompt を" +
    "組み立てる材料。side-effect 0 を保証する。",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", pattern: NAME_PATTERN },
      targets: {
        type: "array",
        items: { enum: TARGETS_DEFAULT },
        default: TARGETS_DEFAULT,
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
} as const;

const NAME_REGEX = new RegExp(NAME_PATTERN);

export interface ValidateArgsOk {
  ok: true;
  args: Required<Omit<RotateSecretArgs, "expected_gcp_version_id">> & {
    expected_gcp_version_id?: string;
  };
}

export interface ValidateArgsErr {
  ok: false;
  error: string;
}

export function validateRotateSecretArgs(
  params: unknown,
): ValidateArgsOk | ValidateArgsErr {
  if (typeof params !== "object" || params === null) {
    return { ok: false, error: "params must be an object" };
  }
  const p = params as Record<string, unknown>;

  if (typeof p.name !== "string" || !NAME_REGEX.test(p.name)) {
    return {
      ok: false,
      error: `name must match ${NAME_PATTERN}`,
    };
  }
  if (
    typeof p.new_value !== "string" ||
    p.new_value.length === 0 ||
    p.new_value.length > 65536
  ) {
    return {
      ok: false,
      error: "new_value must be a non-empty string up to 65536 chars",
    };
  }
  if (typeof p.confirm_name !== "string") {
    return { ok: false, error: "confirm_name must be a string" };
  }
  if (p.confirm_name !== p.name) {
    // confirm mismatch は安全のため詳細を返さない (どちらの値か分かると brute
    // force ヒントになる)。log にも値そのものは出さない。
    return { ok: false, error: "confirm_name does not match name" };
  }

  let targets: RotationTarget[] = TARGETS_DEFAULT;
  if (p.targets !== undefined) {
    if (!Array.isArray(p.targets) || p.targets.length === 0) {
      return { ok: false, error: "targets must be a non-empty array" };
    }
    for (const t of p.targets) {
      if (t !== "gcp" && t !== "cf" && t !== "github") {
        return {
          ok: false,
          error: `unknown target: ${JSON.stringify(t)}`,
        };
      }
    }
    targets = p.targets as RotationTarget[];
  }

  let expectedGcpVersionId: string | undefined;
  if (p.expected_gcp_version_id !== undefined) {
    if (typeof p.expected_gcp_version_id !== "string") {
      return {
        ok: false,
        error: "expected_gcp_version_id must be a string",
      };
    }
    expectedGcpVersionId = p.expected_gcp_version_id;
  }

  return {
    ok: true,
    args: {
      name: p.name,
      new_value: p.new_value,
      confirm_name: p.confirm_name,
      targets,
      ...(expectedGcpVersionId !== undefined
        ? { expected_gcp_version_id: expectedGcpVersionId }
        : {}),
    },
  };
}

/**
 * Phase A の mock 実装。実際の provider への write は行わない。
 * - 各 target に対して `{ status: "ok", ... }` を返す
 * - rotation_id は ISO timestamp + random suffix
 * - `new_value` は response にも返さない (= echo 禁止)
 */
export function executeRotateSecretMock(
  args: ValidateArgsOk["args"],
  options: { dryRun?: boolean; now?: () => Date } = {},
): RotateSecretResult {
  const now = options.now ?? (() => new Date());
  const dryRun = options.dryRun ?? false;
  const timestamp = now().toISOString();
  // Phase A: deterministic 寄りの id 生成 (test 時は now を差し替えできる)。
  // 衝突回避には crypto.randomUUID() suffix を付ける。
  const rotationId = `rot_${timestamp}_${crypto.randomUUID().slice(0, 8)}`;

  const results: RotateSecretResult["results"] = {};
  for (const target of args.targets) {
    results[target] = mockProviderResult(target, args.name, dryRun);
  }

  return {
    ok: true,
    rotation_id: rotationId,
    dry_run: dryRun,
    results,
  };
}

function mockProviderResult(
  target: RotationTarget,
  name: string,
  dryRun: boolean,
): RotateSecretProviderResult {
  if (dryRun) {
    return { status: "skipped" };
  }
  switch (target) {
    case "gcp":
      return {
        status: "ok",
        new_version: `projects/cloudsql-sv/secrets/${name}/versions/MOCK`,
      };
    case "cf":
      return {
        status: "ok",
        secret_id: "MOCK-CF-SECRET-ID",
      };
    case "github":
      return {
        status: "ok",
      };
  }
}

export function validationError(id: number | string | null, message: string): JsonRpcError {
  return makeError(id, JSON_RPC_INVALID_PARAMS, message);
}

// ===========================================================================
// Phase B: 実 write 接続 executor
// ===========================================================================

export interface ExecuteOptions {
  /** test 注入用。本番は global fetch。 */
  fetcher?: typeof fetch;
  /** test 注入用。本番は `() => new Date()`。 */
  now?: () => Date;
  /** actor email (CF Access JWT の email claim)。GCP proxy の actor audit log
   *  に転送される。 */
  actorEmail?: string;
}

/**
 * 3 provider を **並列実行** し、provider 単位の結果を集約する。
 *
 * - partial failure は rollback しない (= issue #18 のセキュリティ要件
 *   「partial failure 時 rollback しない、provider 単位 status を返す」)
 * - new_value は provider 関数 引数として 1 度だけ渡し、log / response /
 *   error にも echo しない (各 provider 内で enforce)
 * - 全 provider success → ok=true、1 つでも fail → ok=false
 *
 * `expected_gcp_version_id` は GCP provider 専用 (TOCTOU)。他 provider に
 * 該当 hook 無し (CF / GitHub は version concept 無し)。
 */
export async function executeRotateSecret(
  args: ValidateArgsOk["args"],
  env: Env,
  options: ExecuteOptions = {},
): Promise<RotateSecretResult> {
  const now = options.now ?? (() => new Date());
  const timestamp = now().toISOString();
  const rotationId = `rot_${timestamp}_${crypto.randomUUID().slice(0, 8)}`;

  // 並列実行。各 provider は throw せず Result を返す契約なので allSettled
  // ではなく Promise.all で OK。failure も Result 経由で集約される。
  const pending: Array<Promise<[RotationTarget, RotateSecretProviderResult]>> = [];

  for (const target of args.targets) {
    pending.push(runProvider(target, args, env, options).then((r) => [target, r]));
  }

  const settled = await Promise.all(pending);

  const results: RotateSecretResult["results"] = {};
  let ok = true;
  for (const [target, result] of settled) {
    results[target] = result;
    if (result.status !== "ok") ok = false;
  }

  return {
    ok,
    rotation_id: rotationId,
    dry_run: false,
    results,
  };
}

async function runProvider(
  target: RotationTarget,
  args: ValidateArgsOk["args"],
  env: Env,
  options: ExecuteOptions,
): Promise<RotateSecretProviderResult> {
  try {
    switch (target) {
      case "gcp":
        return await rotateGcp(
          {
            name: args.name,
            newValue: args.new_value,
            expectedVersionId: args.expected_gcp_version_id,
            actorEmail: options.actorEmail,
          },
          { env, fetcher: options.fetcher },
        );
      case "cf":
        return await rotateCloudflare(
          { name: args.name, newValue: args.new_value },
          { env, fetcher: options.fetcher },
        );
      case "github":
        return await rotateGithub(
          { name: args.name, newValue: args.new_value },
          { env, fetcher: options.fetcher },
        );
    }
  } catch (err) {
    // provider 関数は内部で throw しない契約だが、defense in depth として
    // 上位で握り潰す (= 1 provider の unexpected throw が他 provider 結果を
    // 巻き込まないよう)。message は generic に。
    return {
      status: "fail",
      error: `${target} unexpected: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}

// ===========================================================================
// create_secret tool (= 新規 secret + 初版投入を 3 system に展開)
// ===========================================================================
//
// issue #18 の comment 提案。新 binding 追加時に gcloud / CF dashboard を
// 人手で叩く工程を排除し、AI で完結させる。
//
// rotate_secret との差:
//   - GCP: `POST /create-secret` を叩く (= /add-version の sibling)
//   - CF:  list で既存判定 → 新規 POST / 既存 PATCH
//   - GH:  GET で 404 確認 → PUT (PUT 自体は冪等で create + update 兼用)
//   - `fail_if_exists` default true で誤上書き防止
//   - `expected_gcp_version_id` (TOCTOU) は持たない (= 新規前提)

import { createGcp } from "../../providers/gcp";
import { createCloudflare } from "../../providers/cloudflare";
import { createGithub } from "../../providers/github";

export interface CreateSecretArgs {
  name: string;
  initial_value: string;
  targets?: RotationTarget[];
  confirm_name: string;
  fail_if_exists?: boolean;
  cf_scopes?: string[];
}

export const createSecretTool = {
  name: "create_secret",
  description:
    "3 system に新規 secret を作成し initial value を投入する。" +
    "rotate_secret の create 版。fail_if_exists=true (default) で既存衝突は fail。",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        pattern: NAME_PATTERN,
        description: "secret 名 (SCREAMING_SNAKE / kebab-case、先頭は英字)",
      },
      initial_value: {
        type: "string",
        minLength: 1,
        maxLength: 65536,
        description: "初版値。response / log に echo されない。",
      },
      targets: {
        type: "array",
        items: { enum: TARGETS_DEFAULT },
        default: TARGETS_DEFAULT,
        description: "作成対象 provider 群。省略時は 3 system すべて。",
      },
      confirm_name: {
        type: "string",
        description: "type-to-confirm: name と一致する文字列。不一致なら 400。",
      },
      fail_if_exists: {
        type: "boolean",
        default: true,
        description:
          "true (default) で既存 name 衝突は fail。false で既存 secret を再利用 (= 新 version 投入)。",
      },
      cf_scopes: {
        type: "array",
        items: { type: "string" },
        description: "CF Secrets Store の scopes (default = [\"workers\"])。CF target のみ意味あり。",
      },
    },
    required: ["name", "initial_value", "confirm_name"],
    additionalProperties: false,
  },
} as const;

export interface ValidateCreateArgsOk {
  ok: true;
  args: Required<Omit<CreateSecretArgs, "cf_scopes">> & { cf_scopes?: string[] };
}

export function validateCreateSecretArgs(
  params: unknown,
): ValidateCreateArgsOk | ValidateArgsErr {
  if (typeof params !== "object" || params === null) {
    return { ok: false, error: "params must be an object" };
  }
  const p = params as Record<string, unknown>;

  if (typeof p.name !== "string" || !NAME_REGEX.test(p.name)) {
    return { ok: false, error: `name must match ${NAME_PATTERN}` };
  }
  if (
    typeof p.initial_value !== "string" ||
    p.initial_value.length === 0 ||
    p.initial_value.length > 65536
  ) {
    return {
      ok: false,
      error: "initial_value must be a non-empty string up to 65536 chars",
    };
  }
  if (typeof p.confirm_name !== "string") {
    return { ok: false, error: "confirm_name must be a string" };
  }
  if (p.confirm_name !== p.name) {
    return { ok: false, error: "confirm_name does not match name" };
  }

  let targets: RotationTarget[] = TARGETS_DEFAULT;
  if (p.targets !== undefined) {
    if (!Array.isArray(p.targets) || p.targets.length === 0) {
      return { ok: false, error: "targets must be a non-empty array" };
    }
    for (const t of p.targets) {
      if (t !== "gcp" && t !== "cf" && t !== "github") {
        return { ok: false, error: `unknown target: ${JSON.stringify(t)}` };
      }
    }
    targets = p.targets as RotationTarget[];
  }

  let failIfExists = true;
  if (p.fail_if_exists !== undefined) {
    if (typeof p.fail_if_exists !== "boolean") {
      return { ok: false, error: "fail_if_exists must be a boolean" };
    }
    failIfExists = p.fail_if_exists;
  }

  let cfScopes: string[] | undefined;
  if (p.cf_scopes !== undefined) {
    if (
      !Array.isArray(p.cf_scopes) ||
      !p.cf_scopes.every((s) => typeof s === "string")
    ) {
      return { ok: false, error: "cf_scopes must be string[]" };
    }
    cfScopes = p.cf_scopes as string[];
  }

  return {
    ok: true,
    args: {
      name: p.name,
      initial_value: p.initial_value,
      confirm_name: p.confirm_name,
      targets,
      fail_if_exists: failIfExists,
      ...(cfScopes !== undefined ? { cf_scopes: cfScopes } : {}),
    },
  };
}

/**
 * 3 provider に新規 secret を並列作成。partial failure は rollback しない
 * (= rotate_secret と同じ規約)。各 provider が `created` boolean を返し
 * 集約 result に転送する。
 */
export async function executeCreateSecret(
  args: ValidateCreateArgsOk["args"],
  env: Env,
  options: ExecuteOptions = {},
): Promise<RotateSecretResult> {
  const now = options.now ?? (() => new Date());
  const timestamp = now().toISOString();
  const rotationId = `crt_${timestamp}_${crypto.randomUUID().slice(0, 8)}`;

  const pending: Array<Promise<[RotationTarget, RotateSecretProviderResult]>> = [];
  for (const target of args.targets) {
    pending.push(runCreateProvider(target, args, env, options).then((r) => [target, r]));
  }
  const settled = await Promise.all(pending);

  const results: RotateSecretResult["results"] = {};
  let ok = true;
  for (const [target, result] of settled) {
    results[target] = result;
    if (result.status !== "ok") ok = false;
  }

  return { ok, rotation_id: rotationId, dry_run: false, results };
}

async function runCreateProvider(
  target: RotationTarget,
  args: ValidateCreateArgsOk["args"],
  env: Env,
  options: ExecuteOptions,
): Promise<RotateSecretProviderResult> {
  try {
    switch (target) {
      case "gcp":
        return await createGcp(
          {
            name: args.name,
            initialValue: args.initial_value,
            failIfExists: args.fail_if_exists,
            actorEmail: options.actorEmail,
          },
          { env, fetcher: options.fetcher },
        );
      case "cf":
        return await createCloudflare(
          {
            name: args.name,
            initialValue: args.initial_value,
            failIfExists: args.fail_if_exists,
            scopes: args.cf_scopes,
          },
          { env, fetcher: options.fetcher },
        );
      case "github":
        return await createGithub(
          {
            name: args.name,
            initialValue: args.initial_value,
            failIfExists: args.fail_if_exists,
          },
          { env, fetcher: options.fetcher },
        );
    }
  } catch (err) {
    return {
      status: "fail",
      error: `${target} unexpected: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}
