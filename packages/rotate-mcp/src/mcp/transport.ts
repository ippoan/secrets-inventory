import type { Context } from "hono";
import type { Env, AppVariables } from "../types";
import {
  JSON_RPC_PARSE_ERROR,
  makeError,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonrpc";
import { handleMcpRequest } from "./server";

// MCP transport handlers。
//
// 1. Streamable HTTP (2025-03-26 spec、推奨)
//    - POST /mcp  → 1 リクエスト = 1 レスポンス (JSON body)
//    - notification は HTTP 202、それ以外は 200 + JSON
//
// 2. Legacy HTTP + SSE (2024-11-05 spec、互換用)
//    - GET  /mcp/sse  → SSE stream で endpoint event を発行
//    - POST /mcp/sse  → 受信した request を処理し、SSE stream に message として
//      流す代わりに、Phase A では同期 JSON で返す簡易実装
//
// Phase A の SSE は **接続確立 + endpoint event 通知 + POST 受信 + JSON 直返却**
// に限定する。本格的な per-session multiplexing (= GET 接続を保ったまま POST
// response を SSE で流す) は Durable Object が必要で、Phase B 以降で実装する。

type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

export async function streamableHttpPost(c: AppContext): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = await c.req.json<JsonRpcRequest>();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(makeError(null, JSON_RPC_PARSE_ERROR, message), 400);
  }

  const response = await handleMcpRequest(body, c.env, {
    actorEmail: c.get("cfAccess")?.email,
  });

  if (response === null) {
    // notification: spec 上 response 無し
    return new Response(null, { status: 202 });
  }
  return c.json(response, 200);
}

/**
 * Legacy SSE: GET /mcp/sse で stream を確立し、`event: endpoint` で
 * 同 server 内の POST endpoint を通知する。session 状態は Phase A では持たない
 * (= session id を発行するが、stateless で再現できる範囲のみ)。
 */
export function legacySseGet(_c: AppContext): Response {
  const sessionId = crypto.randomUUID();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // endpoint event: client は以後この URL に POST する
      const endpoint = `/mcp/sse/message?session=${sessionId}`;
      controller.enqueue(
        encoder.encode(`event: endpoint\ndata: ${endpoint}\n\n`),
      );
      // Phase A は endpoint event 1 発を送って即 close する簡易実装。
      // 本来の MCP SSE transport は server からの message を逐次流すために
      // 接続を維持するが、それには Durable Object が必要 (CF Worker subrequest
      // は 30s で強制終了 + state は worker isolate 跨ぎで持てない)。
      // Phase B 以降で DO 化する想定。
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

export async function legacySsePost(c: AppContext): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = await c.req.json<JsonRpcRequest>();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(makeError(null, JSON_RPC_PARSE_ERROR, message), 400);
  }
  const response = await handleMcpRequest(body, c.env, {
    actorEmail: c.get("cfAccess")?.email,
  });
  if (response === null) {
    return new Response(null, { status: 202 });
  }
  // Phase A: SSE stream に push する代わりに同期 JSON で返す。
  // 本来の MCP SSE transport は GET 接続側の stream に流すべきだが、Phase A は
  // mock 接続用なので簡易実装で十分。
  return c.json(response satisfies JsonRpcResponse, 200);
}
