import { describe, expect, it } from "vitest";
import { readFirstTool, readFirstInputSchema } from "../../../src/mcp/tools/read-first";
import { STATIC_TOOLS } from "../../../src/mcp/registry";

describe("read_first input schema", () => {
  it("accepts empty object", () => {
    const parsed = readFirstInputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it("rejects extra fields (strict object)", () => {
    const parsed = readFirstInputSchema.safeParse({ extra: 1 });
    expect(parsed.success).toBe(false);
  });
});

describe("read_first tool metadata", () => {
  it("name is 'MUST_READ_FIRST_or_other_tools_will_fail' (urgency + consequence framing)", () => {
    // 大文字 MUST_READ_FIRST + 小文字 consequence で agent の attention を強く引く。
    expect(readFirstTool.name).toBe("MUST_READ_FIRST_or_other_tools_will_fail");
  });

  it("description starts with MUST READ FIRST (agent navigation hint)", () => {
    expect(readFirstTool.description).toMatch(/^MUST READ FIRST/);
  });

  it("description includes consequence framing (warns about skip)", () => {
    expect(readFirstTool.description).toMatch(/(fail|error|leak|skip)/i);
  });

  it("does not require a scope (callable by anyone with a binding_jwt)", () => {
    expect((readFirstTool as { requiresScope?: string }).requiresScope).toBeUndefined();
  });
});

describe("read_first execute()", () => {
  it("returns intro, tools, http_routes, and workflows", async () => {
    const result = (await readFirstTool.execute()) as {
      intro: string;
      tools: Array<{ name: string; description: string; requires_scope?: string }>;
      http_routes: Array<{ method: string; path: string; purpose: string }>;
      workflows: Record<string, string>;
    };
    expect(result.intro).toContain("secrets-inventory");
    expect(result.intro).toContain("GCP");
    expect(result.intro).toContain("source of truth");
    expect(result.tools.length).toBeGreaterThan(0);
    expect(result.http_routes.length).toBeGreaterThan(0);
    expect(Object.keys(result.workflows).length).toBeGreaterThan(0);
  });

  it("tools listing mirrors STATIC_TOOLS exactly (single source of truth, no drift)", async () => {
    const result = (await readFirstTool.execute()) as {
      tools: Array<{ name: string; description: string; requires_scope?: string }>;
    };
    expect(result.tools).toHaveLength(STATIC_TOOLS.length);
    for (let i = 0; i < STATIC_TOOLS.length; i++) {
      expect(result.tools[i]!.name).toBe(STATIC_TOOLS[i]!.name);
      expect(result.tools[i]!.description).toBe(STATIC_TOOLS[i]!.description);
      if (STATIC_TOOLS[i]!.requiresScope) {
        expect(result.tools[i]!.requires_scope).toBe(STATIC_TOOLS[i]!.requiresScope);
      } else {
        expect(result.tools[i]!.requires_scope).toBeUndefined();
      }
    }
  });

  it("does not include itself in the tools list (no self-reference, no circular dep)", async () => {
    const result = (await readFirstTool.execute()) as {
      tools: Array<{ name: string }>;
    };
    const names = result.tools.map((t) => t.name);
    expect(names).not.toContain("MUST_READ_FIRST_or_other_tools_will_fail");
  });

  it("http_routes lists all LLM-context-safe routes (secret-upload / mint / sync)", async () => {
    const result = (await readFirstTool.execute()) as {
      http_routes: Array<{ path: string }>;
    };
    const paths = result.http_routes.map((r) => r.path);
    expect(paths).toContain("/mcp/secret-upload/:name");
    expect(paths).toContain("/mcp/mint-health-oauth-jwt");
    expect(paths).toContain("/mcp/sync-from-gcp/:name");
  });

  it("workflows include rotate / create / mint+sync / sync-only / check drift", async () => {
    const result = (await readFirstTool.execute()) as {
      workflows: Record<string, string>;
    };
    expect(result.workflows.rotate_existing_secret).toMatch(/curl/);
    expect(result.workflows.create_new_secret).toMatch(/curl/);
    // mint health-oauth workflow walks through mint→sync, so it should
    // reference both endpoints.
    expect(result.workflows.mint_health_oauth_jwt).toMatch(/mint-health-oauth-jwt/);
    expect(result.workflows.mint_health_oauth_jwt).toMatch(/sync-from-gcp/);
    expect(result.workflows.sync_gcp_to_others).toMatch(/sync-from-gcp/);
    expect(result.workflows.check_drift).toMatch(/get_drift/);
  });

  it("output never contains a placeholder for sensitive values (smoke test)", async () => {
    // read_first is the first thing agents see; if accidentally we shipped a
    // template value like "TOKEN_HERE" or "FAKE_PASSWORD", flag it. This is
    // a smoke test against future regressions.
    const result = await readFirstTool.execute();
    const serialised = JSON.stringify(result);
    expect(serialised).not.toMatch(/PASSWORD/i);
    expect(serialised).not.toMatch(/PRIVATE[_ ]KEY/i);
  });
});
