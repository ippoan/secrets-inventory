import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Env } from "../types";
import type { BindingJwtClaims } from "../middleware/binding-jwt";
import { GcpUnavailableError } from "../inventory";
import { GcpIamUnavailableError } from "./tools/list-service-accounts";
import { readFirstTool } from "./tools/read-first";
import { STATIC_TOOLS, type ToolEntry } from "./registry";

// MCP tool 全体は registry (`STATIC_TOOLS`) + `readFirstTool` を結合したもの。
// read_first は最初に呼んでもらいたい想定で **先頭** に置き、tools/list で
// 一番上に出るようにする (= LLM agent の navigation hint)。
const TOOLS: ToolEntry<z.ZodTypeAny>[] = [
  readFirstTool as unknown as ToolEntry<z.ZodTypeAny>,
  ...STATIC_TOOLS,
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
  // zod 4 native の JSON Schema 変換。`target: "draft-7"` で旧 `zod-to-json-schema`
  // の `target: "jsonSchema7"` 相当。`reused` は default "inline" なので旧
  // `$refStrategy: "none"` (= $ref を使わず展開) と同じ挙動になる。
  const jsonSchema = z.toJSONSchema(entry.inputSchema, {
    target: "draft-7",
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
