import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * Workers 向け Transport bridge。
 *
 * SDK の `Server` class は 2 方向 stream を前提とした `Transport` interface
 * (`send` / `onmessage`) を期待するが、Workers の HTTP request-response は
 * 1 リクエスト = 1 レスポンスでサーバーから client へ push する手段が無い。
 *
 * このクラスは 1 つの Transport instance を 1 リクエストに使い切り、`dispatch`
 * で client → server を流し込み、SDK が `send` で返す最初の message を await で
 * 取り出すことで、1:1 化する。複数 request を 1 つの Transport で多重化したり、
 * server-initiated push を行うことは設計上できない。
 *
 * SDK の Server からの `start` / `close` callback は no-op (open/close 概念が
 * 無いため)。`sessionId` は使わない。
 */
export class WorkerTransport implements Transport {
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  private resolveResponse!: (msg: JSONRPCMessage | null) => void;
  private readonly responsePromise: Promise<JSONRPCMessage | null>;
  private resolved = false;

  constructor() {
    this.responsePromise = new Promise<JSONRPCMessage | null>((r) => {
      this.resolveResponse = r;
    });
  }

  async start(): Promise<void> {
    // no-op: connect 直後に dispatch() 経由で onmessage が呼ばれる
  }

  async close(): Promise<void> {
    if (!this.resolved) {
      this.resolved = true;
      this.resolveResponse(null);
    }
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.resolved) {
      // 2 件目以降の server → client message は無視 (= server-initiated push 非対応)。
      // Workers 環境では HTTP response 1 回しか返せないため、最初の message を採用。
      return;
    }
    this.resolved = true;
    this.resolveResponse(message);
  }

  /**
   * 1 つの JSON-RPC message を SDK Server に流し込み、対応する response を返す。
   *
   * - request (`id` 有り) → server から response が `send` 経由で来るまで await
   * - notification (`id` 無し) → response 無しで即 null
   *
   * notification は spec 上 server が response を返さないため、ここで promise を
   * 永遠に待たないよう early return している。
   */
  async dispatch(message: JSONRPCMessage): Promise<JSONRPCMessage | null> {
    if (!this.onmessage) {
      throw new Error("transport not connected: onmessage handler missing");
    }
    const isNotification = !("id" in message) || (message as { id?: unknown }).id === undefined;

    this.onmessage(message);

    if (isNotification) {
      // notification は server が send を呼ばないので response promise が
      // resolve されない。明示的に null で抜ける。
      return null;
    }

    return await this.responsePromise;
  }
}
