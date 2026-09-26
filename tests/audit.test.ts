import { describe, expect, it } from "vitest";
import {
  AUDIT_CHECK_IDS,
  buildAuditReport,
  countChecksByStatus,
  parseAuditReport,
  type AuditCheckId,
  type AuditInput,
} from "../src/shared/audit";
import type { ResolvedIdentity } from "../src/shared/state";

const AUTO_IDENTITY: ResolvedIdentity = {
  source: "auto",
  publicIp: "203.0.113.7",
  observedIp: "203.0.113.7",
  publicIpVerified: true,
  countryCode: "NL",
  region: "North Holland",
  city: "Amsterdam",
  latitude: 52.374,
  longitude: 4.88969,
  accuracy: 20000,
  timezone: "Europe/Amsterdam",
  resolvedAt: 1_700_000_000_000,
  provider: "fake.geoip",
};

function auditInput(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    status: "ready",
    activeProfileId: "profile-0001",
    generation: 3,
    proxy: {
      configured: true,
      type: "http",
      host: "127.0.0.1",
      port: 8080,
      proxyDns: false,
      bypassCount: 3,
      hasCredentials: false,
    },
    identity: AUTO_IDENTITY,
    webrtc: {
      desired: "disable_non_proxied_udp",
      actual: "disable_non_proxied_udp",
      levelOfControl: "controlled_by_this_extension",
      status: "applied",
    },
    content: { hasShim: true, reportedGeneration: 3, reportedTimezone: "Europe/Amsterdam" },
    firefoxProxy: { proxyType: "none", levelOfControl: "controllable_by_this_extension" },
    providerFailed: false,
    ...overrides,
  };
}

function statusOf(input: AuditInput, id: AuditCheckId): string | undefined {
  return buildAuditReport(input).checks.find((check) => check.id === id)?.status;
}

describe("buildAuditReport", () => {
  it("reports a consistent identity when everything is applied", () => {
    const report = buildAuditReport(auditInput());

    expect(report.verdict).toBe("consistent");
    expect(report.checks.map((check) => check.id).sort()).toEqual([...AUDIT_CHECK_IDS].sort());
    expect(countChecksByStatus(report).unavailable).toBeUndefined();
    expect(countChecksByStatus(report).provider_error).toBeUndefined();
    expect(statusOf(auditInput(), "proxy")).toBe("ok");
    expect(statusOf(auditInput(), "public_ip")).toBe("ok");
    expect(statusOf(auditInput(), "timezone")).toBe("ok");
    expect(statusOf(auditInput(), "webrtc")).toBe("ok");
    expect(statusOf(auditInput(), "content_shim")).toBe("ok");
  });

  it("reports inactive when no profile is active", () => {
    const inactive = auditInput({
      activeProfileId: null,
      proxy: {
        configured: false,
        type: "direct",
        proxyDns: false,
        bypassCount: 0,
        hasCredentials: false,
      },
      identity: { source: "auto", publicIpVerified: false },
      content: { hasShim: false, reportedGeneration: null },
      webrtc: { desired: "default", levelOfControl: "unknown", status: "pending" },
    });

    expect(buildAuditReport(inactive).verdict).toBe("inactive");
    expect(statusOf(inactive, "proxy")).toBe("not_configured");
    expect(statusOf(inactive, "public_ip")).toBe("unavailable");
  });

  it("distinguishes a provider error from an unavailable identity", () => {
    const failed = auditInput({
      providerFailed: true,
      identity: { source: "auto", publicIpVerified: false },
    });

    expect(buildAuditReport(failed).verdict).toBe("partial");
    for (const id of ["public_ip", "geoip", "timezone", "geolocation"] as const) {
      expect(statusOf(failed, id), id).toBe("provider_error");
    }
  });

  it("marks manually configured values as manual, not as verified", () => {
    const manual = auditInput({
      identity: {
        source: "manual",
        publicIp: "198.51.100.4",
        publicIpVerified: false,
        latitude: 48.8566,
        longitude: 2.3522,
        accuracy: 500,
        timezone: "Europe/Paris",
      },
    });

    expect(statusOf(manual, "geoip")).toBe("manual");
    expect(statusOf(manual, "geolocation")).toBe("manual");
    expect(statusOf(manual, "timezone")).toBe("manual");
    expect(statusOf(manual, "public_ip")).toBe("pending");
  });

  it("reports a WebRTC policy that another extension controls", () => {
    const controlled = auditInput({
      webrtc: {
        desired: "proxy_only",
        levelOfControl: "controlled_by_other_extensions",
        status: "controlled_by_other",
      },
    });

    expect(statusOf(controlled, "webrtc")).toBe("controlled_by_other_extension");
    expect(buildAuditReport(controlled).verdict).toBe("partial");
  });

  it("reports a failed WebRTC change as an error", () => {
    const broken = auditInput({
      webrtc: {
        desired: "proxy_only",
        levelOfControl: "unknown",
        status: "error",
        message: "boom",
      },
    });

    expect(statusOf(broken, "webrtc")).toBe("error");
    expect(buildAuditReport(broken).verdict).toBe("error");
  });

  it("reports a stale page shim when the generation or timezone differs", () => {
    const staleGeneration = auditInput({
      content: { hasShim: true, reportedGeneration: 2, reportedTimezone: "Europe/Amsterdam" },
    });
    expect(statusOf(staleGeneration, "content_shim")).toBe("stale");

    const staleTimezone = auditInput({
      content: { hasShim: true, reportedGeneration: 3, reportedTimezone: "UTC" },
    });
    expect(statusOf(staleTimezone, "content_shim")).toBe("stale");

    const missing = auditInput({ content: { hasShim: false, reportedGeneration: null } });
    expect(statusOf(missing, "content_shim")).toBe("unavailable");
  });

  it("stays partial when one frame matches and another does not", () => {
    const mixed = auditInput({
      content: {
        hasShim: true,
        reportedGeneration: 3,
        reportedTimezone: "Europe/Amsterdam",
        frameCount: 2,
        currentFrameCount: 1,
        activeTabId: 7,
        activeTabCurrent: true,
      },
    });
    const report = buildAuditReport(mixed);
    expect(statusOf(mixed, "content_shim")).toBe("stale");
    expect(report.verdict).toBe("partial");
    expect(report.checks.find((check) => check.id === "content_shim")?.detail).toContain(
      "Active tab matches",
    );
    expect(report.checks.find((check) => check.id === "content_shim")?.detail).toContain("1 of 2");
  });

  it("reports Firefox's own proxy configuration instead of assuming it is unused", () => {
    const external = auditInput({
      firefoxProxy: { proxyType: "manual", levelOfControl: "controllable_by_this_extension" },
    });
    expect(statusOf(external, "firefox_proxy")).toBe("unavailable");

    const otherExtension = auditInput({
      firefoxProxy: { proxyType: "manual", levelOfControl: "controlled_by_other_extensions" },
    });
    expect(statusOf(otherExtension, "firefox_proxy")).toBe("controlled_by_other_extension");
  });

  it("treats a direct profile as not configured but not as a failure", () => {
    const direct = auditInput({
      proxy: {
        configured: false,
        type: "direct",
        proxyDns: false,
        bypassCount: 3,
        hasCredentials: false,
      },
    });

    expect(statusOf(direct, "proxy")).toBe("not_configured");
    expect(buildAuditReport(direct).verdict).toBe("consistent");
  });

  it("shows pending WebRTC work while an activation is in flight", () => {
    const activating = auditInput({
      status: "activating",
      webrtc: { desired: "proxy_only", levelOfControl: "unknown", status: "pending" },
    });
    expect(statusOf(activating, "webrtc")).toBe("pending");
    expect(buildAuditReport(activating).verdict).toBe("partial");
  });
});

describe("parseAuditReport", () => {
  it("round-trips a report", () => {
    const report = buildAuditReport(auditInput());
    expect(parseAuditReport(report)).toEqual({ ok: true, value: report });
  });

  it("rejects malformed reports", () => {
    const report = buildAuditReport(auditInput());
    expect(parseAuditReport(null).ok).toBe(false);
    expect(parseAuditReport({ verdict: "maybe", checks: [] }).ok).toBe(false);
    expect(parseAuditReport({ verdict: "consistent", checks: "nope" }).ok).toBe(false);
    expect(
      parseAuditReport({
        verdict: "consistent",
        checks: [{ id: "unknown", status: "ok", label: "x" }],
      }).ok,
    ).toBe(false);
    expect(
      parseAuditReport({
        verdict: "consistent",
        checks: [{ id: "proxy", status: "fine", label: "x" }],
      }).ok,
    ).toBe(false);
    expect(parseAuditReport({ ...report, checks: [null] }).ok).toBe(false);
  });
});
