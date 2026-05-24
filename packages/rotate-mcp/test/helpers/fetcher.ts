/**
 * Test 用 stub fetcher。各 endpoint pattern → response の map を引いて
 * `Response` を返す。未マッチは 599 で `Error` を投げる (= test に不備が
 * あれば早期検出)。
 */

export interface RouteSpec {
  /** match: URL に `match` (case-sensitive) が含まれる + method が一致 */
  method: string;
  match: string;
  /** static response。`bodyFn` がある場合はそちらが優先。 */
  body?: unknown;
  status?: number;
  /** request body を見て動的に response を組む場合に使う。 */
  bodyFn?: (req: Request) => unknown | Promise<unknown>;
}

export interface FetcherWithCalls {
  fetcher: typeof fetch;
  calls: Array<{ url: string; method: string; body: string | null }>;
}

export function stubFetcher(routes: RouteSpec[]): FetcherWithCalls {
  const calls: FetcherWithCalls["calls"] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const bodyStr = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method, body: bodyStr });

    for (const r of routes) {
      if (method === r.method.toUpperCase() && url.includes(r.match)) {
        let body: unknown = r.body;
        if (r.bodyFn) {
          const fakeReq = new Request(url, {
            method,
            body: bodyStr ?? undefined,
          });
          body = await r.bodyFn(fakeReq);
        }
        const status = r.status ?? 200;
        // HTTP spec: 204/205/304 cannot have a body — `new Response("{}", {status:204})`
        // throws "Invalid response status code 204". Coerce to null body.
        const isBodyless = status === 204 || status === 205 || status === 304;
        return new Response(isBodyless ? null : JSON.stringify(body ?? {}), {
          status,
          headers: isBodyless ? {} : { "Content-Type": "application/json" },
        });
      }
    }
    throw new Error(`stubFetcher: no route for ${method} ${url}`);
  };
  return { fetcher, calls };
}

/** Curve25519 32 bytes 0 fill の base64 (= test 用 placeholder)。tweetnacl
 *  box.publicKeyLength = 32。署名検証はしないので all-zero でも encrypt 自体は
 *  通る (= GitHub provider の path coverage 目的)。 */
export const TEST_GH_PUBLIC_KEY_B64 = btoa("\0".repeat(32));

/**
 * よくある happy-path 3 provider success の route set。
 * `secretName` を CF list 結果に埋め込み、test 側 rotate_secret の `name`
 * argument と一致させる (= CF provider が name → secret_id 解決できる)。
 */
export function happyPathRoutes(secretName = "X"): RouteSpec[] {
  return [
    {
      method: "POST",
      match: "/add-version",
      body: { ok: true, new_version: `projects/p/secrets/${secretName}/versions/3` },
    },
    {
      method: "GET",
      match: "/secrets_store/stores/",
      body: { success: true, result: [{ id: "cf-id-123", name: secretName }] },
    },
    {
      method: "PATCH",
      match: "/secrets_store/stores/",
      body: { success: true, result: {} },
    },
    {
      method: "GET",
      match: "/actions/secrets/public-key",
      body: { key_id: "kid-1", key: TEST_GH_PUBLIC_KEY_B64 },
    },
    {
      method: "PUT",
      match: "/actions/secrets/",
      status: 204,
    },
  ];
}
