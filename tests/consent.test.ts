import { describe, expect, it } from "vitest";
import { decideGeoIpConsent } from "../src/background/consent";

describe("decideGeoIpConsent", () => {
  it("refuses every lookup when Firefox did not report the consent API", () => {
    const decision = decideGeoIpConsent("http", { apiAvailable: false, optionalGranted: [] });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("consent_required");
  });

  it("allows a proxied lookup after install-time location consent", () => {
    expect(decideGeoIpConsent("http", { apiAvailable: true, optionalGranted: [] }).allowed).toBe(
      true,
    );
    expect(decideGeoIpConsent("socks5", { apiAvailable: true, optionalGranted: [] }).allowed).toBe(
      true,
    );
  });

  it("refuses a direct lookup until optional personal-data collection is granted", () => {
    const denied = decideGeoIpConsent("direct", { apiAvailable: true, optionalGranted: [] });
    expect(denied.allowed).toBe(false);
    expect(denied.code).toBe("consent_required");

    const allowed = decideGeoIpConsent("direct", {
      apiAvailable: true,
      optionalGranted: ["personallyIdentifyingInfo"],
    });
    expect(allowed.allowed).toBe(true);
  });
});
