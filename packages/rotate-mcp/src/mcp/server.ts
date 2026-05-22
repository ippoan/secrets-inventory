import type { Env } from "../types";
import {
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_INTERNAL_ERROR,
  isJsonRpcRequest,
  makeError,
  makeSuccess,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonrpc";
import {
  rotateSecretTool,
  dryRunRotateTool,
  validateRotateSecretArgs,
  executeRotateSecretMock,
  validationError,
} from "./tools/rotate-secret";

/**
 * 1 つの JSON-RPC リクエストを処理する。notification (= `id` 不在) は null を
 * 返し、呼び出し側は HTTP 202 を返却する。
 */
export async function handleMcpRequest(
  req: JsonRpcRequest,
  env: Env,
): Promise<JsonRpcResponse | null> {
  if (!isJsonRpcRequest(req)) {
    return makeError(null, JSON_RPC_INVALID_REQUEST, "not a JSON-RPC 2.0 request");
  }
  const id = req.id ?? null;
  // notification (id 不在) は spec 上 response を返さない
  if (req.id === undefined) {
    return null;
  }

  try {
    switch (req.method) {
      case "initialize":
        return makeSuccess(id, {
          protocolVersion: env.MCP_PROTOCOL_VERSION,
          serverInfo: {
            name: env.MCP_SERVER_NAME,
            version: env.MCP_SERVER_VERSION,
          },
          capabilities: {
            tools: { listChanged: false },
          },
        });

      case "ping":
        return makeSuccess(id, {});

      case "tools/list":
        return makeSuccess(id, {
          tools: [rotateSecretTool, dryRunRotateTool],
        });

      case "tools/call":
        return handleToolsCall(id, req.params);

      default:
        return makeError(
          id,
          JSON_RPC_METHOD_NOT_FOUND,
          `unknown method: ${req.method}`,
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal error";
    return makeError(id, JSON_RPC_INTERNAL_ERROR, message);
  }
}

function handleToolsCall(
  id: number | string | null,
  rawParams: unknown,
): JsonRpcResponse {
  if (typeof rawParams !== "object" || rawParams === null) {
    return validationError(id, "tools/call params must be an object");
  }
  const params = rawParams as { name?: unknown; arguments?: unknown };
  if (typeof params.name !== "string") {
    return validationError(id, "tools/call params.name must be a string");
  }

  switch (params.name) {
    case "rotate_secret": {
      const validated = validateRotateSecretArgs(params.arguments);
      if (!validated.ok) {
        return validationError(id, validated.error);
      }
      const result = executeRotateSecretMock(validated.args, { dryRun: false });
      return makeSuccess(id, toolCallResult(result));
    }
    case "dry_run_rotate": {
      // dry_run_rotate は rotate_secret の subset。confirm_name / new_value は不要。
      if (typeof params.arguments !== "object" || params.arguments === null) {
        return validationError(id, "dry_run_rotate arguments must be an object");
      }
      const args = params.arguments as Record<string, unknown>;
      const dryArgs = {
        ...args,
        new_value: "DRY_RUN_PLACEHOLDER",
        confirm_name: args.name,
      };
      const validated = validateRotateSecretArgs(dryArgs);
      if (!validated.ok) {
        return validationError(id, validated.error);
      }
      const result = executeRotateSecretMock(validated.args, { dryRun: true });
      return makeSuccess(id, toolCallResult(result));
    }
    default:
      return makeError(
        id,
        JSON_RPC_METHOD_NOT_FOUND,
        `unknown tool: ${params.name}`,
      );
  }
}

/**
 * MCP `tools/call` の response 規約に従って `content` に structured JSON を載せる。
 * `new_value` は **絶対に** 含めない (response echo 禁止 = issue #18 セキュリティ要件)。
 */
function toolCallResult(payload: unknown): { content: unknown[]; isError: false } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload),
      },
    ],
    isError: false,
  };
}
