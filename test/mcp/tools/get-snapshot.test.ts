import { describe, expect, it } from "vitest";
import { getSnapshotTool, getSnapshotInputSchema } from "../../../src/mcp/tools/get-snapshot";
import type { Env } from "../../../src/types";
import { baseTestEnv } from "../../test-helpers";

describe("get_snapshot", () => {
  it("input schema rejects any field", () => {
    expect(getSnapshotInputSchema.safeParse({}).success).toBe(true);
    expect(getSnapshotInputSchema.safeParse({ foo: 1 }).success).toBe(false);
  });

  it("returns null when KV has no snapshot", async () => {
    const kv: KVNamespace = {
      get: async () => null,
    } as unknown as KVNamespace;
    const env = baseTestEnv({ SNAPSHOT_KV: kv }) as Env;
    const result = await getSnapshotTool.execute(env, {});
    expect(result).toBeNull();
  });

  it("returns snapshot when KV has a valid v1 entry", async () => {
    const snapshot = {
      v: 1,
      captured_at: "2026-05-21T00:00:00.000Z",
      names: ["A", "B"],
    };
    const kv: KVNamespace = {
      get: async () => snapshot,
    } as unknown as KVNamespace;
    const env = baseTestEnv({ SNAPSHOT_KV: kv }) as Env;
    const result = await getSnapshotTool.execute(env, {});
    expect(result).toEqual(snapshot);
  });
});
