import type { SecretMetadata } from "../types";

const GITHUB_API = "https://api.github.com";

export interface GitHubContext {
  token: string;
  org: string;
}

export class GitHubApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

interface GitHubSecretRaw {
  name: string;
  created_at: string;
  updated_at: string;
  visibility?: string;
  selected_repositories_url?: string;
}

interface OrgSecretsResponse {
  total_count: number;
  secrets: GitHubSecretRaw[];
}

/**
 * `GET /orgs/{org}/actions/secrets` で org-level secrets のメタデータを返す。
 * 値フィールドは API 自体が返さない。
 *
 * - fine-grained PAT 推奨。scope は organization secrets: read のみ
 * - 100 件を超える org は per_page=100 でページネーション
 */
export async function listGitHubOrgSecrets(
  ctx: GitHubContext,
): Promise<SecretMetadata[]> {
  const out: SecretMetadata[] = [];
  let page = 1;

  while (true) {
    const url = `${GITHUB_API}/orgs/${encodeURIComponent(ctx.org)}/actions/secrets?per_page=100&page=${page}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "secrets-inventory",
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new GitHubApiError(
        res.status,
        `GitHub API ${res.status}: ${body}`,
      );
    }

    const json = (await res.json()) as OrgSecretsResponse;
    for (const s of json.secrets) {
      out.push({
        name: s.name,
        created_at: s.created_at,
        updated_at: s.updated_at,
        extra: {
          visibility: s.visibility ?? null,
        },
      });
    }

    if (json.secrets.length < 100) break;
    page += 1;
    // 無限ループ防止: ページネーションは現実的に 100 ページ (1 万件) 以下
    if (page > 100) {
      throw new GitHubApiError(
        500,
        "GitHub org secrets pagination exceeded 100 pages — aborting",
      );
    }
  }

  return out;
}
