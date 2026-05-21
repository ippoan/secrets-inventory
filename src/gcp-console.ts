/**
 * GCP Secret Manager コンソールへの URL 生成。値を取り出す導線は常にコンソール
 * に逃がす設計なので、UI と (将来) ci-dashboard 双方から使う想定。
 */

const BASE = "https://console.cloud.google.com/security/secret-manager";

export function gcpConsoleListUrl(projectId: string): string {
  return `${BASE}?project=${encodeURIComponent(projectId)}`;
}

export function gcpConsoleSecretUrl(
  projectId: string,
  secretName: string,
): string {
  return `${BASE}/secret/${encodeURIComponent(secretName)}/versions?project=${encodeURIComponent(projectId)}`;
}
