import { describe, it, expect } from "vitest";
import { buildInventory } from "../src/diff";
import type { SecretMetadata } from "../src/types";

function s(name: string, created_at = "2026-01-01T00:00:00Z"): SecretMetadata {
  return { name, created_at };
}

describe("buildInventory", () => {
  it("sorts rows by name (locale)", () => {
    const { rows } = buildInventory({
      gcp: [s("B"), s("A"), s("C")],
      github: [],
      cloudflare: [],
      previousGcpNames: null,
    });
    expect(rows.map((r) => r.name)).toEqual(["A", "B", "C"]);
  });

  it("marks in_github / in_cloudflare from set membership", () => {
    const { rows } = buildInventory({
      gcp: [s("ALPHA"), s("BETA")],
      github: [s("ALPHA")],
      cloudflare: [s("BETA"), s("GAMMA")],
      previousGcpNames: [],
    });
    const alpha = rows.find((r) => r.name === "ALPHA")!;
    const beta = rows.find((r) => r.name === "BETA")!;
    expect(alpha.in_github).toBe(true);
    expect(alpha.in_cloudflare).toBe(false);
    expect(beta.in_github).toBe(false);
    expect(beta.in_cloudflare).toBe(true);
  });

  it("returns null for in_github / in_cloudflare when that provider failed", () => {
    const { rows } = buildInventory({
      gcp: [s("X")],
      github: null,
      cloudflare: null,
      previousGcpNames: null,
    });
    expect(rows[0]?.in_github).toBeNull();
    expect(rows[0]?.in_cloudflare).toBeNull();
  });

  it("first capture (previousGcpNames=null): is_new_since_snapshot all false + empty diff", () => {
    const { rows, diff } = buildInventory({
      gcp: [s("A"), s("B")],
      github: [],
      cloudflare: [],
      previousGcpNames: null,
    });
    expect(rows.every((r) => r.is_new_since_snapshot === false)).toBe(true);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("diff: detects added names vs previous snapshot", () => {
    const { rows, diff } = buildInventory({
      gcp: [s("A"), s("B"), s("C")],
      github: [],
      cloudflare: [],
      previousGcpNames: ["A", "B"],
    });
    expect(diff.added).toEqual(["C"]);
    expect(diff.removed).toEqual([]);
    expect(rows.find((r) => r.name === "C")?.is_new_since_snapshot).toBe(true);
    expect(rows.find((r) => r.name === "A")?.is_new_since_snapshot).toBe(false);
  });

  it("diff: detects removed names vs previous snapshot", () => {
    const { diff } = buildInventory({
      gcp: [s("A")],
      github: [],
      cloudflare: [],
      previousGcpNames: ["A", "B", "C"],
    });
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual(["B", "C"]);
  });

  it("diff is empty when current == previous (no change)", () => {
    const { diff } = buildInventory({
      gcp: [s("A"), s("B")],
      github: [],
      cloudflare: [],
      previousGcpNames: ["B", "A"],
    });
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("empty previousGcpNames ([]) means previous snapshot existed but was empty (so all current are new)", () => {
    const { rows, diff } = buildInventory({
      gcp: [s("A")],
      github: [],
      cloudflare: [],
      previousGcpNames: [],
    });
    expect(diff.added).toEqual(["A"]);
    expect(rows[0]?.is_new_since_snapshot).toBe(true);
  });

  it("preserves GCP metadata on each row", () => {
    const meta: SecretMetadata = {
      name: "X",
      created_at: "2026-03-03T00:00:00Z",
      extra: { labels: { env: "prod" } },
    };
    const { rows } = buildInventory({
      gcp: [meta],
      github: [],
      cloudflare: [],
      previousGcpNames: null,
    });
    expect(rows[0]?.gcp).toBe(meta);
  });
});
