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
import type { BindingJwtClaims } from "../middleware/binding-jwt";
import { GcpUnavailableError } from "../inventory";
import { listInventoryTool } from "./tools/list-inventory";
import {
  listServiceAccountsTool,
  GcpIamUnavailableError,
} from "./tools/list-service-accounts";
import { getDriftTool } from "./tools/get-drift";
import { getSnapshotTool } from "./tools/get-snapshot";
import { rotateSecretTool, dryRunRotateTool } from "./tools/rotate-secret";
import { createSecretTool } from "./tools/create-secret";

/**
 * MCP tool entry。`requiresScope` を立てた tool は binding_jwt の scope に
 * その値が含まれていない限り `tools/call` で 403 相当を返す (= write tool は
 * `mcp.write` scope を要求する `rotate_secret` / `create_secret` に使う)。
 *
 * `execute` の 3 引数目 `actorEmail` は binding_jwt の sub から導出した actor
 * email を渡す (= GCP proxy の actor audit log に転送される)。read tool は
 * 受け取らないので無視できる。
 */
interface ToolEntry<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  requiresScope?: string;
  execute: (env: Env, args: z.infer<S>, actorEmail?: string) => Promise<unknown>;
}

// `as ToolEntry<z.ZodTypeAny>` で各 tool の zod schema 型情報を unify する。
// 個別の args 型は execute 内に閉じているので外には漏れない。
const TOOLS: ToolEntry<z.ZodTypeAny>[] = [
  listInventoryTool as unknown as ToolEntry<z.ZodTypeAny>,
  listServiceAccountsTool as unknown as ToolEntry<z.ZodTypeAny>,
  getDriftTool as unknown as ToolEntry<z.ZodTypeAny>,
  getSnapshotTool as unknown as ToolEntry<z.ZodTypeAny>,
  // write tools (Refs #45 Stage 2): packages/rotate-mcp から移植。
  // requiresScope: "mcp.write" で binding_jwt scope check が走る。
  rotateSecretTool as unknown as ToolEntry<z.ZodTypeAny>,
  dryRunRotateTool as unknown as ToolEntry<z.ZodTypeAny>,
  createSecretTool as unknown as ToolEntry<z.ZodTypeAny>,
];

/**
 * MCP `Server` instance を組み立てる。リクエスト 1 回ごとに新しい instance を
 * 生成する想定 (= Workers の 1 request = 1 isolate context モデルに合わせる)。
 *
 * SDK 1.x の `Server.setRequestHandler` で `tools/list` と `tools/call` を
 * 登録する。validation は各 tool 内の zod schema で行い、SDK 側の schema
 * mismatch は捕まえない (= SDK 自体は inputSchema を strict には参照しない)。
 *
 * `claims` 引数は binding_jwt middleware が `c.get("bindingJwt")` から取り
 * 出したもの。`scope` field を見て write tool を gate する。
 */
export function createMcpServer(env: Env, claims?: BindingJwtClaims): Server {
  const scopes = parseScopes(claims?.scope);
  const actorEmail = actorEmailFromClaims(claims);

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
    // tools/list は scope に関係なく全 tool の name + schema を返す (= client が
    // どの tool が存在するか discover できる UX を優先)。scope 不足の tool を
    // 呼んだら tools/call で 403 相当が返る。
    tools: TOOLS.map((t) => toMcpTool(t)),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return errorResult(`unknown tool: ${req.params.name}`);
    }

    if (tool.requiresScope && !scopes.has(tool.requiresScope)) {
      // MCP spec に 403 は無いので `isError: true` で返す。message には
      // どの scope が要るかを書いて caller (AI) が認可問題と区別できるようにする。
      return errorResult(
        `forbidden: tool ${tool.name} requires scope "${tool.requiresScope}", got "${claims?.scope ?? ""}"`,
      );
    }

    const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return errorResult(`invalid arguments: ${parsed.error.message}`);
    }

    try {
      const payload = await tool.execute(env, parsed.data, actorEmail);
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
 * `scope` は OAuth 慣例で空白区切り文字列。`"mcp.read mcp.write"` →
 * `Set("mcp.read", "mcp.write")` 等。claims 未提供 (= local test 等で
 * middleware を bypass する場合) は空 Set (= write tool は invoke 不可)。
 */
function parseScopes(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(/\s+/).filter((s) => s.length > 0));
}

/**
 * `sub` claim から actor email を導出する。auth-worker は sub に GitHub login
 * を入れているため、そのまま email 風に扱える文字列にはならないが、actor
 * audit log には十分。github_login が利用できる場合はそちらを優先 (= 人間が
 * 識別しやすい)。
 */
function actorEmailFromClaims(claims: BindingJwtClaims | undefined): string | undefined {
  if (!claims) return undefined;
  return claims.github_login || claims.sub || undefined;
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
