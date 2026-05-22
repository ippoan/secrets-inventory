import { describe, it, expect } from "vitest";
import {
  isJsonRpcRequest,
  makeError,
  makeSuccess,
} from "../src/mcp/jsonrpc";

describe("isJsonRpcRequest", () => {
  it("accepts a valid shape", () => {
    expect(
      isJsonRpcRequest({ jsonrpc: "2.0", method: "x" }),
    ).toBe(true);
  });

  it("rejects null", () => {
    expect(isJsonRpcRequest(null)).toBe(false);
  });

  it("rejects wrong jsonrpc version", () => {
    expect(isJsonRpcRequest({ jsonrpc: "1.0", method: "x" })).toBe(false);
  });

  it("rejects missing method", () => {
    expect(isJsonRpcRequest({ jsonrpc: "2.0" })).toBe(false);
  });

  it("rejects primitives", () => {
    expect(isJsonRpcRequest("x")).toBe(false);
    expect(isJsonRpcRequest(1)).toBe(false);
  });
});

describe("makeError / makeSuccess", () => {
  it("makeError without data omits the data field", () => {
    const e = makeError(1, -32601, "no");
    expect(e.error).toEqual({ code: -32601, message: "no" });
  });

  it("makeError with data includes the data field", () => {
    const e = makeError(1, -32603, "bad", { detail: "x" });
    expect(e.error.data).toEqual({ detail: "x" });
  });

  it("makeSuccess produces a JSON-RPC success envelope", () => {
    const s = makeSuccess(2, { ok: true });
    expect(s).toEqual({ jsonrpc: "2.0", id: 2, result: { ok: true } });
  });
});
