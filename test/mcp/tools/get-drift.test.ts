import { describe, expect, it } from "vitest";
import { getDriftInputSchema } from "../../../src/mcp/tools/get-drift";

describe("get_drift input schema", () => {
  it("accepts empty object (defaults to all targets at execute time)", () => {
    const parsed = getDriftInputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it("accepts targets = ['github']", () => {
    const parsed = getDriftInputSchema.safeParse({ targets: ["github"] });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown target value", () => {
    const parsed = getDriftInputSchema.safeParse({ targets: ["bogus"] });
    expect(parsed.success).toBe(false);
  });

  it("rejects empty targets array (min(1))", () => {
    const parsed = getDriftInputSchema.safeParse({ targets: [] });
    expect(parsed.success).toBe(false);
  });

  it("rejects extra fields (strict object)", () => {
    const parsed = getDriftInputSchema.safeParse({
      targets: ["github"],
      foo: 1,
    });
    expect(parsed.success).toBe(false);
  });
});
