import { describe, expect, it } from "vitest";
import { listInventoryInputSchema } from "../../../src/mcp/tools/list-inventory";

describe("list_inventory input schema", () => {
  it("accepts empty object", () => {
    expect(listInventoryInputSchema.safeParse({}).success).toBe(true);
  });

  it("accepts commit_snapshot=true", () => {
    expect(
      listInventoryInputSchema.safeParse({ commit_snapshot: true }).success,
    ).toBe(true);
  });

  it("accepts commit_snapshot=false", () => {
    expect(
      listInventoryInputSchema.safeParse({ commit_snapshot: false }).success,
    ).toBe(true);
  });

  it("rejects commit_snapshot as string", () => {
    expect(
      listInventoryInputSchema.safeParse({ commit_snapshot: "yes" }).success,
    ).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      listInventoryInputSchema.safeParse({ extra: 1 }).success,
    ).toBe(false);
  });
});
