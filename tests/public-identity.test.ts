import { describe, expect, it } from "vitest";
import {
  BRIDGE_SOURCE,
  GEOIP_ACCURACY_METERS,
  PAGE_SOURCE,
  PUBLIC_IDENTITY_NS,
} from "../src/shared/constants";
import {
  createIdentityEnvelope,
  createPageAnnounce,
  createPageAppliedReport,
  createPublicIdentity,
  hasIdentityContent,
  parseIdentityEnvelope,
  parsePageAnnounce,
  parsePageAppliedReport,
  parsePublicIdentity,
  serializeForPage,
} from "../src/shared/public-identity";

describe("createPublicIdentity", () => {
  it("carries coordinates with an accuracy", () => {
    expect(
      createPublicIdentity({
        generation: 4,
        latitude: 52.374,
        longitude: 4.88969,
        accuracy: 25000,
        timezone: "Europe/Amsterdam",
      }),
    ).toEqual({
      ns: PUBLIC_IDENTITY_NS,
      generation: 4,
      latitude: 52.374,
      longitude: 4.88969,
      accuracy: 25000,
      timezone: "Europe/Amsterdam",
    });
  });

  it("never emits coordinates without a coarse accuracy", () => {
    const withoutAccuracy = createPublicIdentity({ generation: 1, latitude: 1, longitude: 2 });
    expect(withoutAccuracy?.accuracy).toBe(GEOIP_ACCURACY_METERS);

    const nonsenseAccuracy = createPublicIdentity({
      generation: 1,
      latitude: 1,
      longitude: 2,
      accuracy: 0,
    });
    expect(nonsenseAccuracy?.accuracy).toBe(GEOIP_ACCURACY_METERS);
  });

  it("supports a timezone-only identity", () => {
    expect(createPublicIdentity({ generation: 7, timezone: "Asia/Tokyo" })).toEqual({
      ns: PUBLIC_IDENTITY_NS,
      generation: 7,
      timezone: "Asia/Tokyo",
    });
  });

  it("returns null when there is nothing to apply", () => {
    expect(createPublicIdentity({ generation: 1 })).toBeNull();
    expect(createPublicIdentity({ generation: 1, timezone: "Mars/Olympus" })).toBeNull();
    expect(createPublicIdentity({ generation: 1, latitude: 100, longitude: 200 })).toBeNull();
  });

  it("drops an unusable timezone but keeps coordinates", () => {
    const identity = createPublicIdentity({
      generation: 2,
      latitude: 10,
      longitude: 20,
      accuracy: 500,
      timezone: "Not/AZone",
    });
    expect(identity?.timezone).toBeUndefined();
    expect(identity?.latitude).toBe(10);
  });

  it("exposes only the documented keys, so proxy data cannot leak into a page", () => {
    const identity = createPublicIdentity({
      generation: 3,
      latitude: 1,
      longitude: 2,
      accuracy: 300,
      timezone: "UTC",
    });
    expect(identity).not.toBeNull();
    expect(Object.keys(identity ?? {}).sort()).toEqual([
      "accuracy",
      "generation",
      "latitude",
      "longitude",
      "ns",
      "timezone",
    ]);
  });
});

describe("hasIdentityContent", () => {
  it("is true only when something can be applied", () => {
    expect(hasIdentityContent({ ns: PUBLIC_IDENTITY_NS, generation: 1 })).toBe(false);
    expect(hasIdentityContent({ ns: PUBLIC_IDENTITY_NS, generation: 1, timezone: "UTC" })).toBe(
      true,
    );
    expect(hasIdentityContent({ ns: PUBLIC_IDENTITY_NS, generation: 1, latitude: 1 })).toBe(true);
  });
});

describe("parsePublicIdentity", () => {
  it("round-trips a valid payload", () => {
    const identity = createPublicIdentity({
      generation: 5,
      latitude: 1.5,
      longitude: 2.5,
      accuracy: 900,
    });
    expect(identity).not.toBeNull();
    expect(parsePublicIdentity(identity)).toEqual({ ok: true, value: identity });
  });

  it("rejects payloads that would let a page see something unexpected", () => {
    const invalid: unknown[] = [
      null,
      "string",
      [],
      { generation: 1 },
      { ns: "someone-else", generation: 1 },
      { ns: PUBLIC_IDENTITY_NS, generation: -1 },
      { ns: PUBLIC_IDENTITY_NS, generation: 1.5 },
      { ns: PUBLIC_IDENTITY_NS, generation: 1, latitude: 1 },
      { ns: PUBLIC_IDENTITY_NS, generation: 1, latitude: 1, longitude: 2 },
      { ns: PUBLIC_IDENTITY_NS, generation: 1, latitude: 91, longitude: 2, accuracy: 10 },
      { ns: PUBLIC_IDENTITY_NS, generation: 1, latitude: 1, longitude: 181, accuracy: 10 },
      { ns: PUBLIC_IDENTITY_NS, generation: 1, latitude: 1, longitude: 2, accuracy: -5 },
      { ns: PUBLIC_IDENTITY_NS, generation: 1, timezone: "Mars/Olympus" },
    ];

    for (const value of invalid) {
      expect(parsePublicIdentity(value).ok, JSON.stringify(value)).toBe(false);
    }
  });
});

describe("identity envelope", () => {
  it("round-trips a payload for the bridge channel", () => {
    const payload = createPublicIdentity({ generation: 2, timezone: "UTC" });
    const envelope = createIdentityEnvelope(payload, false, true);
    expect(parseIdentityEnvelope(envelope, BRIDGE_SOURCE)).toEqual({ ok: true, value: envelope });
  });

  it("supports a pending envelope without a payload", () => {
    const envelope = createIdentityEnvelope(null, true, true);
    expect(parseIdentityEnvelope(envelope, BRIDGE_SOURCE)).toEqual({ ok: true, value: envelope });
  });

  it("rejects envelopes with the wrong source or a malformed payload", () => {
    expect(parseIdentityEnvelope(createIdentityEnvelope(null, false, false), PAGE_SOURCE).ok).toBe(
      false,
    );
    expect(
      parseIdentityEnvelope(
        { source: BRIDGE_SOURCE, type: "identity", payload: null },
        BRIDGE_SOURCE,
      ).ok,
    ).toBe(false);
    expect(
      parseIdentityEnvelope(
        { source: BRIDGE_SOURCE, type: "identity", payload: null, pending: true },
        BRIDGE_SOURCE,
      ).ok,
    ).toBe(false);
    expect(
      parseIdentityEnvelope(
        {
          source: BRIDGE_SOURCE,
          type: "identity",
          pending: false,
          payload: { ns: "x", generation: 1 },
        },
        BRIDGE_SOURCE,
      ).ok,
    ).toBe(false);
  });
});

describe("page channel messages", () => {
  it("round-trips the announce message", () => {
    expect(parsePageAnnounce(createPageAnnounce())).toEqual({
      ok: true,
      value: createPageAnnounce(),
    });
    expect(parsePageAnnounce({ source: BRIDGE_SOURCE, type: "hello" }).ok).toBe(false);
    expect(parsePageAnnounce({ source: PAGE_SOURCE, type: "other" }).ok).toBe(false);
  });

  it("round-trips the applied report and validates it", () => {
    const report = createPageAppliedReport({
      generation: 3,
      timezone: "UTC",
      hasGeolocationOverride: true,
    });
    expect(parsePageAppliedReport(report)).toEqual({ ok: true, value: report });

    expect(
      parsePageAppliedReport({ ...report, timezone: "Mars/Olympus" }).ok,
      "an invalid timezone must be rejected",
    ).toBe(false);
    expect(parsePageAppliedReport({ ...report, generation: -1 }).ok).toBe(false);
    expect(parsePageAppliedReport({ ...report, hasGeolocationOverride: "yes" }).ok).toBe(false);
    expect(parsePageAppliedReport({ ...report, source: BRIDGE_SOURCE }).ok).toBe(false);
  });
});

describe("serializeForPage", () => {
  it("contains only public identity data", () => {
    const payload = createPublicIdentity({
      generation: 9,
      latitude: 1.23,
      longitude: 4.56,
      accuracy: 20000,
      timezone: "Europe/Amsterdam",
    });

    const serialized = serializeForPage(payload, false, true);

    expect(serialized).toContain(BRIDGE_SOURCE);
    expect(serialized).not.toMatch(/password|username|authorization|proxyHost|bypass/i);
    expect(JSON.parse(serialized)).toEqual(createIdentityEnvelope(payload, false, true));
  });
});
