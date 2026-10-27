// MCP にログインした人 (例: claude@ippoan.org) の GCP 権限で Google API を呼ぶ (Refs #101)。
//
// アクセストークンは auth-worker の RPC `GoogleGcpTokenEntrypoint#accessToken(binding_jwt)`
// から受け取る (ippoan/auth-worker#691)。refresh token は auth-worker の外に出ず、
// ここが持つのは 1 時間のアクセストークンだけ (リクエストの間だけ使い、保存しない)。
// 値は log / 応答 / エラーメッセージに出さない。
//
// claude@ は普段 GCP の書き込み権限を持たず、PAM の申請者であるだけ。承認されるまで
// 書き込みは 403 になるので、その 403 は「request_write_access で申請する」案内に変える。
import type { Env } from "../types";
import type { ToolContext } from "../mcp/registry";

export const PAM_API = "https://privilegedaccessmanager.googleapis.com/v1";
export const SECRET_MANAGER_API = "https://secretmanager.googleapis.com/v1";

export const REAUTHORIZE_MESSAGE =
  "Google Cloud の権限が使えません。MCP コネクタを繋ぎ直し、Google のログインで " +
  "Google Cloud へのアクセス (cloud-platform) に同意してください。" +
  "同意は 7 日で切れることがあります (OAuth 同意画面がテスト中のため)。";

export const NO_WRITE_ACCESS_MESSAGE =
  "書き込み権限がありません。`request_write_access` で PAM に申請し、承認されてから " +
  "もう一度実行してください (状態は `get_write_access` で確認できます)。";

export class GcpUserError extends Error {}

/** ログインした人の短命アクセストークン。取れなければ理由つきで throw する。 */
export async function userAccessToken(env: Env, ctx: ToolContext | undefined): Promise<string> {
  if (!env.AUTH_GCP_TOKEN) {
    throw new GcpUserError("AUTH_GCP_TOKEN binding が設定されていません (auth-worker の GoogleGcpTokenEntrypoint)");
  }
  if (!ctx?.bindingJwt) throw new GcpUserError(REAUTHORIZE_MESSAGE);
  const res = await env.AUTH_GCP_TOKEN.accessToken(ctx.bindingJwt);
  if (res.status === 200) {
    const body = JSON.parse(res.body) as { access_token?: string };
    if (body.access_token) return body.access_token;
  }
  if (res.status === 401) throw new GcpUserError(REAUTHORIZE_MESSAGE);
  throw new GcpUserError(`auth-worker から Google Cloud のトークンを取れませんでした (status ${res.status})`);
}

/**
 * Google API を、ログインした人のトークンで呼ぶ。2xx は JSON を返し、
 * 403 は「申請して承認を待つ」案内、それ以外は Google のエラー要旨を throw する。
 */
export async function callGoogleApi<T>(
  token: string,
  url: string,
  init: { method?: string; body?: unknown; allowNotFound?: boolean } = {},
): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (res.ok) return (text ? JSON.parse(text) : {}) as T;
  if (res.status === 404 && init.allowNotFound) return null as T;
  if (res.status === 401) throw new GcpUserError(REAUTHORIZE_MESSAGE);
  if (res.status === 403) throw new GcpUserError(NO_WRITE_ACCESS_MESSAGE);
  let message = text.slice(0, 300);
  try {
    message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
  } catch {
    // JSON でなければ本文の先頭をそのまま使う
  }
  throw new GcpUserError(`Google API ${res.status}: ${message}`);
}
