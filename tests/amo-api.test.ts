import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createJwt, inspectionSummary } from "../src/release/amo-api";
import { EXTENSION_ID } from "../src/release/version";

const addon = { guid: EXTENSION_ID, status: "nominated", is_disabled: false };
const detail = {
  version: "1.0.0",
  channel: "listed",
  file: { status: "unreviewed", is_mozilla_signed_extension: false },
};

describe("read-only AMO inspection", () => {
  it("uses a short-lived HS256 JWT with unique nonce", () => {
    const jwt = createJwt("test-issuer", "test-secret", 100000);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({
      alg: "HS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toMatchObject({
      iss: "test-issuer",
      iat: 100,
      exp: 160,
    });
    expect(signature).toBe(
      createHmac("sha256", "test-secret").update(`${header}.${payload}`).digest("base64url"),
    );
    expect(createJwt("test-issuer", "test-secret", 100000)).not.toBe(jwt);
    expect(() => createJwt("", "")).toThrow(/credentials/);
  });
  it("reports pending and absent versions without raw data", () => {
    expect(
      inspectionSummary(addon, { ...detail, approval_notes: "private" }, "1.0.0"),
    ).toMatchObject({ fileStatus: "unreviewed", exists: true });
    expect(JSON.stringify(inspectionSummary(addon, detail, "1.0.0"))).not.toContain(
      "approval_notes",
    );
    expect(inspectionSummary(addon, null, "1.1.0")).toMatchObject({ exists: false });
  });
  it("rejects malformed responses, wrong extension, version and channel", () => {
    for (const value of [null, [], {}, { ...addon, guid: "wrong" }]) {
      expect(() => inspectionSummary(value, detail, "1.0.0")).toThrow();
    }
    for (const value of [
      {},
      { ...detail, version: "2.0.0" },
      { ...detail, channel: "unknown" },
      { ...detail, file: {} },
    ]) {
      expect(() => inspectionSummary(addon, value, "1.0.0")).toThrow();
    }
  });
});
