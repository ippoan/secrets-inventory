import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listServiceAccountsInputSchema,
  listServiceAccountsTool,
} from "../../../src/mcp/tools/list-service-accounts";
import type { Env } from "../../../src/types";
import { baseTestEnv } from "../../test-helpers";

describe("list_service_accounts input schema", () => {
  it("accepts empty object", () => {
    expect(listServiceAccountsInputSchema.safeParse({}).success).toBe(true);
  });

  it("rejects any field (strict empty object)", () => {
    expect(
      listServiceAccountsInputSchema.safeParse({ filter: "candidate" }).success,
    ).toBe(false);
  });
});

describe("list_service_accounts execute", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates to gatherSaInventory and returns its result", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ service_accounts: [] }),
    );
    const env = baseTestEnv({ SNAPSHOT_KV: {} as KVNamespace }) as Env;
    const result = await listServiceAccountsTool.execute(env, {});
    expect(result.gcp_project_id).toBe("cloudsql-sv");
    expect(Array.isArray(result.rows)).toBe(true);
    expect(result.summary).toBeDefined();
  });
});
