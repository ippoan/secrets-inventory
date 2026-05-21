import { describe, it, expect } from "vitest";
import { gcpConsoleListUrl, gcpConsoleSecretUrl } from "../src/gcp-console";

describe("gcpConsoleListUrl", () => {
  it("encodes the project id query param", () => {
    expect(gcpConsoleListUrl("cloudsql-sv")).toBe(
      "https://console.cloud.google.com/security/secret-manager?project=cloudsql-sv",
    );
  });
});

describe("gcpConsoleSecretUrl", () => {
  it("builds the per-secret versions URL", () => {
    expect(gcpConsoleSecretUrl("cloudsql-sv", "STRIPE_API_KEY")).toBe(
      "https://console.cloud.google.com/security/secret-manager/secret/STRIPE_API_KEY/versions?project=cloudsql-sv",
    );
  });

  it("URL-encodes secret name segments (defensive — names should be [A-Z0-9_])", () => {
    expect(gcpConsoleSecretUrl("p", "weird/name")).toContain(
      "/secret/weird%2Fname/versions",
    );
  });
});
