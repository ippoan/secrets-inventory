import { describe, it, expect, vi, afterEach } from "vitest";
import {
  listGitHubOrgSecrets,
  GitHubApiError,
  type GitHubContext,
} from "../../src/providers/github";

const ctx: GitHubContext = {
  token: "ghp_test",
  org: "ippoan",
};

describe("listGitHubOrgSecrets", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the org secrets endpoint with bearer + api version header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ total_count: 0, secrets: [] }),
    );
    await listGitHubOrgSecrets(ctx);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.github.com/orgs/ippoan/actions/secrets?per_page=100&page=1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer ghp_test",
          "X-GitHub-Api-Version": "2022-11-28",
        }),
      }),
    );
  });

  it("URL-encodes the org segment", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ total_count: 0, secrets: [] }),
    );
    await listGitHubOrgSecrets({ ...ctx, org: "weird/org" });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/orgs/weird%2Forg/actions/secrets"),
      expect.anything(),
    );
  });

  it("maps secrets to SecretMetadata with visibility in extra", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        total_count: 2,
        secrets: [
          {
            name: "DEPLOY_KEY",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-02-01T00:00:00Z",
            visibility: "all",
          },
          {
            name: "NPM_TOKEN",
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
            visibility: "selected",
          },
        ],
      }),
    );
    const items = await listGitHubOrgSecrets(ctx);
    expect(items).toHaveLength(2);
    expect(items[0]?.name).toBe("DEPLOY_KEY");
    expect((items[0]?.extra as { visibility: string }).visibility).toBe("all");
    for (const it of items) {
      expect(it).not.toHaveProperty("value");
    }
  });

  it("paginates: keeps fetching while a page is full (100)", async () => {
    const page1 = {
      total_count: 150,
      secrets: Array.from({ length: 100 }, (_, i) => ({
        name: `S${i}`,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      })),
    };
    const page2 = {
      total_count: 150,
      secrets: Array.from({ length: 50 }, (_, i) => ({
        name: `S${100 + i}`,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      })),
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(page1))
      .mockResolvedValueOnce(Response.json(page2));

    const items = await listGitHubOrgSecrets(ctx);
    expect(items).toHaveLength(150);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]?.[0]).toEqual(
      expect.stringContaining("page=2"),
    );
  });

  it("throws GitHubApiError on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );
    await expect(listGitHubOrgSecrets(ctx)).rejects.toThrow(GitHubApiError);
  });
});
