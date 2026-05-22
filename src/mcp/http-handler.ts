import type { Context } from "hono";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Env } from "../types";
import { createMcpServer } from "./server";
import { WorkerTransport } from "./transport";

// HTTP handlers (Hono context → MCP SDK Server bridge)。
//
// - POST /mcp                    : streamable HTTP (2025-03-26 spec、推奨 transport)
// - GET  /mcp/sse                : legacy HTTP+SSE 互換 (2024-11-05 spec)
// - POST /mcp/sse/message        : legacy SSE の message ingest
//
// 1 リクエスト = 1 Server instance = 1 Transport instance。session 状態は持たない。
// 本格的な long-lived SSE (per-session multiplexing) は Durable Object が必要なため、
// legacy SSE は endpoint event を 1 発送って即 close する簡易実装に留める
// (= secrets-rotate-mcp の Phase A と同等の挙動)。

type AppContext = Context<{ Bindings: Env }>;

const JSON_RPC_PARSE_ERROR = -32700;

async function dispatchOnce(
  c: AppContext,
): Promise<Response> {
  let body: JSONRPCMessage;
  try {
    body = (await c.req.json()) as JSONRPCMessage;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: JSON_RPC_PARSE_ERROR, message },
      },
      400,
    );
  }

  const server = createMcpServer(c.env);
  const transport = new WorkerTransport();
  await server.connect(transport);

  try {
    const response = await transport.dispatch(body);
    if (response === null) {
      // notification: spec 上 response 無し
      return new Response(null, { status: 202 });
    }
    return c.json(response, 200);
  } finally {
    await transport.close();
    await server.close();
  }
}

export const streamableHttpPost = dispatchOnce;
export const legacySsePost = dispatchOnce;

export function legacySseGet(_c: AppContext): Response {
  const sessionId = crypto.randomUUID();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const endpoint = `/mcp/sse/message?session=${sessionId}`;
      controller.enqueue(
        encoder.encode(`event: endpoint\ndata: ${endpoint}\n\n`),
      );
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-MCP-Session-Id": sessionId,
    },
  });
}
