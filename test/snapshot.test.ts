import { describe, it, expect } from "vitest";
import {
  readSnapshot,
  writeSnapshot,
  SNAPSHOT_KEY,
} from "../src/snapshot";

/** in-memory KVNamespace mock — テストに必要な put/get(json) のみ実装 */
function makeKv(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: async (key: string, opts?: unknown) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      if (opts === "json" || (opts as { type?: string })?.type === "json") {
        return JSON.parse(raw);
      }
      return raw;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}

describe("readSnapshot", () => {
  it("returns null when key is missing", async () => {
    const kv = makeKv();
    expect(await readSnapshot(kv)).toBeNull();
  });

  it("returns null when stored shape has wrong v", async () => {
    const kv = makeKv({
      [SNAPSHOT_KEY]: JSON.stringify({ v: 999, names: [] }),
    });
    expect(await readSnapshot(kv)).toBeNull();
  });

  it("returns null when stored shape lacks names array", async () => {
    const kv = makeKv({
      [SNAPSHOT_KEY]: JSON.stringify({ v: 1, captured_at: "x" }),
    });
    expect(await readSnapshot(kv)).toBeNull();
  });

  it("returns the snapshot with names sorted as-stored (no re-sort on read)", async () => {
    const kv = makeKv({
      [SNAPSHOT_KEY]: JSON.stringify({
        v: 1,
        captured_at: "2026-05-21T00:00:00.000Z",
        names: ["B", "A"],
      }),
    });
    const snap = await readSnapshot(kv);
    expect(snap?.v).toBe(1);
    expect(snap?.captured_at).toBe("2026-05-21T00:00:00.000Z");
    expect(snap?.names).toEqual(["B", "A"]);
  });

  it("filters out non-string entries from a corrupted names array (defensive)", async () => {
    const kv = makeKv({
      [SNAPSHOT_KEY]: JSON.stringify({
        v: 1,
        captured_at: "2026-05-21T00:00:00.000Z",
        names: ["A", 42, null, "B"],
      }),
    });
    const snap = await readSnapshot(kv);
    expect(snap?.names).toEqual(["A", "B"]);
  });
});

describe("writeSnapshot", () => {
  it("sorts names alphabetically and stamps captured_at", async () => {
    const kv = makeKv();
    const fixed = new Date("2026-05-21T12:34:56.000Z");
    const written = await writeSnapshot(kv, ["B", "A", "C"], () => fixed);
    expect(written.v).toBe(1);
    expect(written.captured_at).toBe("2026-05-21T12:34:56.000Z");
    expect(written.names).toEqual(["A", "B", "C"]);

    // KV にも入っている
    const reread = await readSnapshot(kv);
    expect(reread?.names).toEqual(["A", "B", "C"]);
  });

  it("write + read round trip preserves an empty snapshot", async () => {
    const kv = makeKv();
    await writeSnapshot(kv, [], () => new Date(0));
    const snap = await readSnapshot(kv);
    expect(snap?.names).toEqual([]);
  });
});
