/**
 * DO + WebSocket (stateful) MCP transport (Refs #70 / ippoan/mcp-cf-workers#6)。
 *
 * 既存の stateless `/mcp` (`src/mcp/http-handler.ts` + `transport.ts`) は温存し、
 * **別 route `/mcp-do`** に DO+WS path を **dual-path** で追加する (段階移行)。
 * deploy で WS が drop → Claude Code が自動再接続 → initialize/tools/list 再取得、
 * という経路で #70 の「deploy 後に live session が旧 schema で固まる」実害を解く。
 * (runtime の listChanged push は Claude Code クライアント側が未消費なので当てに
 * しない。詳細は ippoan/mcp-cf-workers#12 / CLAUDE.md 参照。)
 *
 * tool 群は stateless 版と同じ registry (`STATIC_TOOLS` + `readFirstTool`) を
 * single source として使い、`McpServer.registerTool` に adapter する。scope gate
 * は edge auth (`introspectBindingJwt`) が返す `props.scope` で行う (stateless 版の
 * `createMcpServer` と同じ認可セマンティクス)。
 */
import { createDurableMcp, mountDurableMcp } from "@ippoan/mcp-cf-workers/durable";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Env } from "../types";
import {
  introspectBindingJwt,
  BindingJwtError,
  wwwAuthenticate,
  DEFAULT_AUTH_WORKER_ORIGIN,
  type BindingJwtClaims,
} from "../middleware/binding-jwt";
import { GcpUnavailableError } from "../inventory";
import { GcpIamUnavailableError } from "./tools/list-service-accounts";
import { readFirstTool } from "./tools/read-first";
import { STATIC_TOOLS, type ToolEntry } from "./registry";

// serverInfo の name/version。DO class は env 取得前 (field initializer) に
// McpServer を構築するため static。stateless 版が使う env.MCP_SERVER_NAME /
// _VERSION とは別系統だが serverInfo 表示のみの差なので影響は cosmetic。
const MCP_NAME = "secrets-inventory";
const MCP_VERSION = "0.1.0";

// stateless 版 (server.ts) と同じ: read_first を先頭に置き tools/list で最上位に
// 出す (LLM agent への navigation hint)。
const TOOLS: ToolEntry<z.ZodTypeAny>[] = [
  readFirstTool as unknown as ToolEntry<z.ZodTypeAny>,
  ...STATIC_TOOLS,
];

/** edge auth が DO session に引き渡す props。`scope` で write tool を gate する。 */
interface SessionProps extends Record<string, unknown> {
  scope: string;
  actor?: string;
}

/**
 * Durable Object class。`wrangler.jsonc` の `durable_objects.bindings`
 * (`MCP_DO`) + `migrations.new_sqlite_classes` で登録する。`src/index.ts` から
 * re-export する必要がある (wrangler は worker entry の named export を要求)。
 */
export const SecretsInventoryMcp = createDurableMcp<Env, SessionProps>({
  name: MCP_NAME,
  version: MCP_VERSION,
  registerTools(server: McpServer, env: Env, props: SessionProps) {
    const scopes = parseScopes(props.scope);
    const actor = props.actor;

    for (const tool of TOOLS) {
      // registry の inputSchema は全て z.object(...)。`.shape` (ZodRawShape) を
      // McpServer.registerTool に渡すと SDK 側が validation + JSON Schema 化 +
      // listChanged capability を担う。
      const shape = (tool.inputSchema as z.ZodObject<z.ZodRawShape>).shape;
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: shape },
        async (args: Record<string, unknown>): Promise<CallToolResult> => {
          if (tool.requiresScope && !scopes.has(tool.requiresScope)) {
            // MCP spec に 403 は無いので isError: true で返す (stateless 版と同様)。
            return errorResult(
              `forbidden: tool ${tool.name} requires scope "${tool.requiresScope}", got "${props.scope ?? ""}"`,
            );
          }
          try {
            const payload = await tool.execute(env, args as never, actor);
            return successResult(payload);
          } catch (err) {
            return errorResult(toolErrorMessage(err));
          }
        },
      );
    }
  },
});

// DO serve の edge wiring。authenticate は下の handleDurableMcp 側で行い (env を
// 使って WWW-Authenticate header を組むため)、ここでは props を載せた ctx を
// そのまま serve に委譲する。
const serveDurableMcp = mountDurableMcp<Env>({
  agent: SecretsInventoryMcp,
  path: "/mcp-do",
  binding: "MCP_DO",
  transport: "streamable-http",
});

/**
 * `/mcp-do` の fetch handler。edge で binding_jwt を検証し (stateless `/mcp` と
 * 同じ auth UX: 401 は WWW-Authenticate で claude.ai connector の OAuth discovery
 * を起動)、claims を `props` として DO session に引き渡してから serve する。
 */
export async function handleDurableMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let claims: BindingJwtClaims;
  try {
    claims = await introspectBindingJwt(request.headers.get("Authorization"), env);
  } catch (err) {
    if (err instanceof BindingJwtError) {
      const authOrigin = env.AUTH_WORKER_ORIGIN ?? DEFAULT_AUTH_WORKER_ORIGIN;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (err.status === 401) {
        headers["WWW-Authenticate"] = wwwAuthenticate(authOrigin, err.errorCode ?? "invalid_token");
      }
      return new Response(JSON.stringify({ error: err.message }), {
        status: err.status,
        headers,
      });
    }
    throw err;
  }

  const props: SessionProps = {
    scope: claims.scope,
    actor: claims.github_login || claims.sub,
  };
  // `ctx.props` は agents SDK の引き渡しスロット (McpAgent.serve が読む)。
  (ctx as ExecutionContext & { props?: Record<string, unknown> }).props = props;

  return serveDurableMcp(request, env, ctx);
}

/**
 * `scope` は OAuth 慣例で空白区切り文字列。未提供は空 Set (= write tool 不可)。
 * stateless 版 server.ts の同名ロジックと揃える。
 */
function parseScopes(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(/\s+/).filter((s) => s.length > 0));
}

function successResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: false,
  };
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/** stateless 版 server.ts の toolErrorMessage と同一の翻訳。 */
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
