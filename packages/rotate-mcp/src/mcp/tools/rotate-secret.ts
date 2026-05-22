import {
  JSON_RPC_INVALID_PARAMS,
  makeError,
  type JsonRpcError,
} from "../jsonrpc";
import type {
  RotateSecretArgs,
  RotateSecretResult,
  RotateSecretProviderResult,
  RotationTarget,
} from "../../types";

// MCP tool 定義 (tools/list で expose する schema)。issue #18 の draft schema と
// 揃える。Phase A は mock なので実 write はせず、入力検証 + result mock を返す。

const NAME_PATTERN = "^[A-Z][A-Z0-9_]{0,127}$";
const TARGETS_DEFAULT: RotationTarget[] = ["gcp", "cf", "github"];

export const rotateSecretTool = {
  name: "rotate_secret",
  description:
    "GCP Secret Manager を source of truth として、新値を 3 system に投入。" +
    "type-to-confirm / value preview / TOCTOU 検証込み。" +
    "Phase A: mock 実装、実 write はせず result mock を返す。",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        pattern: NAME_PATTERN,
        description: "secret 名 (大文字英数 + underscore、先頭は英字)",
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
