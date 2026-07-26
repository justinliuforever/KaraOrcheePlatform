import { describe, it, expect } from "vitest";
import { parseConfig, normalizePrivateKey } from "../src/config";

// A syntactically valid PKCS#8 body — parseConfig only checks the envelope.
const PEM = ["-----BEGIN PRIVATE KEY-----", "MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg", "-----END PRIVATE KEY-----"].join("\n");

const base = { DATABASE_URL: "postgres://localhost/x" };

describe("APNs config group", () => {
  it("wholly unset is a supported state — no key, no pushes, boot succeeds", () => {
    const r = parseConfig(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.apns).toBeNull();
  });

  it("a half-set group fails at boot and names what is missing", () => {
    const r = parseConfig({ ...base, APNS_KEY_ID: "ABC123DEFG" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join(" ")).toContain("APNS_TEAM_ID");
      expect(r.errors.join(" ")).toContain("APNS_PRIVATE_KEY");
    }
  });

  it("a complete group resolves, defaulting the topic and the APNs environment", () => {
    const r = parseConfig({
      ...base,
      APNS_KEY_ID: "ABC123DEFG",
      APNS_TEAM_ID: "BLTUYJ4NAD",
      APNS_PRIVATE_KEY: PEM,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.apns).toEqual({
        keyId: "ABC123DEFG",
        teamId: "BLTUYJ4NAD",
        privateKey: PEM,
        bundleId: "com.karaorchee.karaorcheeamt",
        environment: "production",
      });
    }
  });

  it("a key that is not a PKCS#8 PEM fails at boot rather than at the first send", () => {
    const r = parseConfig({
      ...base,
      APNS_KEY_ID: "ABC123DEFG",
      APNS_TEAM_ID: "BLTUYJ4NAD",
      APNS_PRIVATE_KEY: "not-a-key",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("APNS_PRIVATE_KEY");
  });

  it("accepts the .p8 as base64, as literal PEM, and with escaped newlines", () => {
    expect(normalizePrivateKey(Buffer.from(PEM).toString("base64"))).toBe(PEM);
    expect(normalizePrivateKey(PEM)).toBe(PEM);
    expect(normalizePrivateKey(PEM.replace(/\n/g, "\\n"))).toBe(PEM);
  });
});
