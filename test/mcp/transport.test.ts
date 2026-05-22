import { describe, expect, it } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { WorkerTransport } from "../../src/mcp/transport";

describe("WorkerTransport", () => {
  it("dispatch (request) waits for send and returns the response", async () => {
    const transport = new WorkerTransport();
    let received: JSONRPCMessage | undefined;
    transport.onmessage = (msg) => {
      received = msg;
      // simulate the SDK Server sending a response for the request
      void transport.send({
        jsonrpc: "2.0",
        id: (msg as { id: number }).id,
        result: { ok: true },
      });
    };
    const response = await transport.dispatch({
      jsonrpc: "2.0",
      id: 42,
      method: "ping",
    });
    expect(received).toMatchObject({ method: "ping", id: 42 });
    expect(response).toMatchObject({ id: 42, result: { ok: true } });
  });

  it("dispatch (notification = no id) returns null immediately without awaiting send", async () => {
    const transport = new WorkerTransport();
    let sendCalled = false;
    transport.onmessage = () => {
      // server should not send anything for notifications
    };
    // monkey-patch send to detect if it gets called
    const origSend = transport.send.bind(transport);
    transport.send = async (m) => {
      sendCalled = true;
      return await origSend(m);
    };

    const response = await transport.dispatch({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    } as JSONRPCMessage);
    expect(response).toBeNull();
    expect(sendCalled).toBe(false);
  });

  it("dispatch throws if onmessage is not set (= not connected)", async () => {
    const transport = new WorkerTransport();
    await expect(
      transport.dispatch({ jsonrpc: "2.0", id: 1, method: "ping" }),
    ).rejects.toThrow("transport not connected");
  });

  it("close calls onclose and unblocks pending dispatch with null", async () => {
    const transport = new WorkerTransport();
    let closeCalled = false;
    transport.onclose = () => {
      closeCalled = true;
    };
    transport.onmessage = () => {
      // server never sends; we will close from outside to unblock
    };
    const pending = transport.dispatch({
      jsonrpc: "2.0",
      id: 99,
      method: "slow_method",
    });
    // resolve dispatch by closing
    await transport.close();
    const result = await pending;
    expect(result).toBeNull();
    expect(closeCalled).toBe(true);
  });

  it("send only resolves the first message (subsequent sends are dropped)", async () => {
    const transport = new WorkerTransport();
    transport.onmessage = (msg) => {
      // send two responses, only the first should win
      void transport.send({
        jsonrpc: "2.0",
        id: (msg as { id: number }).id,
        result: { which: "first" },
      });
      void transport.send({
        jsonrpc: "2.0",
        id: (msg as { id: number }).id,
        result: { which: "second" },
      });
    };
    const response = await transport.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    expect(response).toMatchObject({ result: { which: "first" } });
  });

  it("start is a no-op (does not throw)", async () => {
    const transport = new WorkerTransport();
    await expect(transport.start()).resolves.toBeUndefined();
  });
});
