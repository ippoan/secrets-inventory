import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { z } from "zod";
import type { Env } from "../types";
import { GcpUnavailableError } from "../inventory";
import { listInventoryTool } from "./tools/list-inventory";
import {
  listServiceAccountsTool,
  GcpIamUnavailableError,
} from "./tools/list-service-accounts";
import { getDriftTool } from "./tools/get-drift";
import { getSnapshotTool } from "./tools/get-snapshot";

/**
 * read MCP server で expose する tool 群。`execute` の戻り値は JSON serializable
 * であれば何でも良く、call result の `content[0].text` に stringify されて返る。
 */
interface ToolEntry<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  execute: (env: Env, args: z.infer<S>) => Promise<unknown>;
}

// `as ToolEntry<z.ZodTypeAny>` で各 tool の zod schema 型情報を unify する。
// 個別の args 型は execute 内に閉じているので外には漏れない。
const TOOLS: ToolEntry<z.ZodTypeAny>[] = [
  listInventoryTool as unknown as ToolEntry<z.ZodTypeAny>,
  listServiceAccountsTool as unknown as ToolEntry<z.ZodTypeAny>,
  getDriftTool as unknown as ToolEntry<z.ZodTypeAny>,
  getSnapshotTool as unknown as ToolEntry<z.ZodTypeAny>,
];

/**
 * MCP `Server` instance を組み立てる。リクエスト 1 回ごとに新しい instance を
 * 生成する想定 (= Workers の 1 request = 1 isolate context モデルに合わせる)。
 *
 * SDK 1.x の `Server.setRequestHandler` で `tools/list` と `tools/call` を
 * 登録する。validation は各 tool 内の zod schema で行い、SDK 側の schema
 * mismatch は捕まえない (= SDK 自体は inputSchema を strict には参照しない)。
 */
export function createMcpServer(env: Env): Server {
  const server = new Server(
    {
      name: env.MCP_SERVER_NAME,
      version: env.MCP_SERVER_VERSION,
    },
    {
      capabilities: {
        tools: { listChanged: false },
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => toMcpTool(t)),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return errorResult(`unknown tool: ${req.params.name}`);
    }

    const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return errorResult(`invalid arguments: ${parsed.error.message}`);
    }

    try {
      const payload = await tool.execute(env, parsed.data);
      return successResult(payload);
    } catch (err) {
      return errorResult(toolErrorMessage(err));
    }
  });

  return server;
}

function toMcpTool(entry: ToolEntry<z.ZodTypeAny>): Tool {
  const jsonSchema = zodToJsonSchema(entry.inputSchema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Tool["inputSchema"];
  return {
    name: entry.name,
    description: entry.description,
    inputSchema: jsonSchema,
  };
}

function successResult(payload: unknown): CallToolResult {
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

function errorResult(message: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    isError: true,
  };
}

/**
 * tool 実行時の例外を user-facing message に翻訳する。GCP / GCP IAM proxy
 * unavailable は呼び出し元に意味が伝わるよう専用 prefix を付ける。それ以外は
 * Error.message をそのまま使う (内部 stack trace は出さない)。
 */
function toolErrorMessage(err: unknown): string {
  if (err instanceof GcpUnavailableError) {
    return `GCP unavailable: ${err.message}`;
  }
  if (err instanceof GcpIamUnavailableError) {
    return `GCP IAM proxy unavailable: ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
