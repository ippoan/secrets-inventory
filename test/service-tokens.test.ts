import { describe, it, expect } from "vitest";
import {
  reconcileServiceTokens,
  CF_TOKEN_ID_LABEL,
  type ServiceTokenRow,
} from "../src/service-tokens";
import type { SecretMetadata } from "../src/types";

function cfToken(
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
): SecretMetadata {
  return {
    name,
    id,
    extra: { kind: "service_token", ...extra },
  };
}

function gcpSecret(
  name: string,
  labels: Record<string, string> = {},
): SecretMetadata {
  return { name, extra: { labels } };
}

function byStatus(rows: ServiceTokenRow[]) {
  return {
    ok: rows.filter((r) => r.status === "ok"),
    orphan: rows.filter((r) => r.status === "orphan"),
    missing: rows.filter((r) => r.status === "missing_in_cf"),
  };
}

describe("reconcileServiceTokens", () => {
  it("matches CF token id against GCP cf_token_id label → ok", () => {
    const { rows } = reconcileServiceTokens({
      cfServiceTokens: [cfToken("st-1", "testone")],
      gcpSecrets: [
        gcpSecret("testone-client-secret", { [CF_TOKEN_ID_LABEL]: "st-1" }),
      ],
    });
    const g = byStatus(rows);
    expect(g.ok).toHaveLength(1);
    expect(g.ok[0]?.cf_token_id).toBe("st-1");
    expect(g.ok[0]?.cf?.name).toBe("testone");
    expect(g.ok[0]?.gcp?.name).toBe("testone-client-secret");
    expect(g.orphan).toHaveLength(0);
    expect(g.missing).toHaveLength(0);
  });

  it("CF token with no matching label → orphan (野良)", () => {
    const { rows } = reconcileServiceTokens({
      cfServiceTokens: [cfToken("st-wild", "wild")],
      gcpSecrets: [gcpSecret("unrelated", { system: "secwatch" })],
    });
    const g = byStatus(rows);
    expect(g.orphan).toHaveLength(1);
    expect(g.orphan[0]?.cf?.name).toBe("wild");
    expect(g.orphan[0]?.gcp).toBeNull();
    expect(g.orphan[0]?.cf_token_id).toBe("st-wild");
  });

  it("GCP label with no matching CF token → missing_in_cf (記録漏れ)", () => {
    const { rows } = reconcileServiceTokens({
      cfServiceTokens: [],
      gcpSecrets: [
        gcpSecret("ghost-secret", { [CF_TOKEN_ID_LABEL]: "st-gone" }),
      ],
    });
    const g = byStatus(rows);
    expect(g.missing).toHaveLength(1);
    expect(g.missing[0]?.gcp?.name).toBe("ghost-secret");
    expect(g.missing[0]?.cf).toBeNull();
    expect(g.missing[0]?.cf_token_id).toBe("st-gone");
  });

  it("mixes ok / orphan / missing and sorts drift first", () => {
    const { rows } = reconcileServiceTokens({
      cfServiceTokens: [
        cfToken("st-ok", "matched"),
        cfToken("st-wild", "wild"),
      ],
      gcpSecrets: [
        gcpSecret("matched-secret", { [CF_TOKEN_ID_LABEL]: "st-ok" }),
        gcpSecret("ghost", { [CF_TOKEN_ID_LABEL]: "st-gone" }),
      ],
    });
    const g = byStatus(rows);
    expect(g.ok).toHaveLength(1);
    expect(g.orphan).toHaveLength(1);
    expect(g.missing).toHaveLength(1);
    // sort: orphan (0) → missing_in_cf (1) → ok (2)
    expect(rows.map((r) => r.status)).toEqual([
      "orphan",
      "missing_in_cf",
      "ok",
    ]);
  });

  it("ignores non-cf_token_id labels and empty label values", () => {
    const { rows } = reconcileServiceTokens({
      cfServiceTokens: [cfToken("st-1", "t")],
      gcpSecrets: [
        gcpSecret("a", { [CF_TOKEN_ID_LABEL]: "" }), // empty → not a 台帳 entry
        gcpSecret("b", { other: "st-1" }), // wrong label key
      ],
    });
    const g = byStatus(rows);
    // st-1 は台帳に無い (空ラベル / 別キーは無視) → orphan
    expect(g.orphan).toHaveLength(1);
    expect(g.missing).toHaveLength(0);
  });

  it("sorts same-status rows by name (orphan z after orphan a)", () => {
    const { rows } = reconcileServiceTokens({
      cfServiceTokens: [cfToken("st-z", "zebra"), cfToken("st-a", "alpha")],
      gcpSecrets: [],
    });
    // 両方 orphan → name 昇順
    expect(rows.map((r) => r.cf?.name)).toEqual(["alpha", "zebra"]);
  });

  it("CF fetch failure (null) → empty rows (突合不能、誤検出しない)", () => {
    const { rows } = reconcileServiceTokens({
      cfServiceTokens: null,
      gcpSecrets: [
        gcpSecret("ghost", { [CF_TOKEN_ID_LABEL]: "st-gone" }),
      ],
    });
    expect(rows).toEqual([]);
  });

  it("handles GCP secret with no extra/labels safely", () => {
    const { rows } = reconcileServiceTokens({
      cfServiceTokens: [cfToken("st-1", "t")],
      gcpSecrets: [{ name: "no-extra" }, { name: "null-extra", extra: null }],
    });
    expect(byStatus(rows).orphan).toHaveLength(1);
  });
});
