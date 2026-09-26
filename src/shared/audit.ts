/**
 * Identity consistency audit.
 *
 * The audit reports what is actually true, using precise terms, and never claims
 * more than the code guarantees. It deliberately distinguishes "not configured",
 * "unavailable", "controlled by another extension" and "provider error" instead
 * of collapsing everything into a success flag.
 *
 * Verdict mapping:
 *   inactive    - no profile is active
 *   error       - an operation failed in a way the extension can observe
 *   partial     - something is missing or outside this extension's control
 *   consistent  - every configured aspect is applied and observed
 */
import { fail, isPlainObject, ok, type Result } from "./result";

import type {
  ContentRuntimeState,
  FirefoxProxyRuntimeState,
  ProxyRuntimeSummary,
  ResolvedIdentity,
  RuntimeStatus,
  WebRtcRuntimeState,
} from "./state";

export type AuditCheckId =
  | "proxy"
  | "public_ip"
  | "geoip"
  | "timezone"
  | "geolocation"
  | "webrtc"
  | "content_shim"
  | "firefox_proxy";

export type AuditCheckStatus =
  | "ok"
  | "not_configured"
  | "unavailable"
  | "manual"
  | "provider_error"
  | "controlled_by_other_extension"
  | "stale"
  | "pending"
  | "error";

export type AuditVerdict = "inactive" | "consistent" | "partial" | "error";

export const AUDIT_CHECK_IDS: readonly AuditCheckId[] = [
  "proxy",
  "public_ip",
  "geoip",
  "timezone",
  "geolocation",
  "webrtc",
  "content_shim",
  "firefox_proxy",
];

export const AUDIT_CHECK_STATUSES: readonly AuditCheckStatus[] = [
  "ok",
  "not_configured",
  "unavailable",
  "manual",
  "provider_error",
  "controlled_by_other_extension",
  "stale",
  "pending",
  "error",
];

export const AUDIT_VERDICTS: readonly AuditVerdict[] = [
  "inactive",
  "consistent",
  "partial",
  "error",
];

export interface AuditCheck {
  id: AuditCheckId;
  label: string;
  status: AuditCheckStatus;
  detail?: string;
}

export interface AuditReport {
  verdict: AuditVerdict;
  checks: AuditCheck[];
}

export interface AuditInput {
  status: RuntimeStatus;
  activeProfileId: string | null;
  /** Activation generation currently in force; compared against page reports. */
  generation: number;
  proxy: ProxyRuntimeSummary;
  identity: ResolvedIdentity;
  webrtc: WebRtcRuntimeState;
  content: ContentRuntimeState;
  firefoxProxy: FirefoxProxyRuntimeState;
  /** True when the most recent identity lookup failed in the provider layer. */
  providerFailed: boolean;
}

export function parseAuditReport(value: unknown): Result<AuditReport> {
  if (!isPlainObject(value)) return fail("audit report must be an object");
  if (
    typeof value.verdict !== "string" ||
    !(AUDIT_VERDICTS as readonly string[]).includes(value.verdict)
  ) {
    return fail("audit verdict is invalid");
  }
  if (!Array.isArray(value.checks)) return fail("audit checks must be a list");

  const checks: AuditCheck[] = [];
  for (const rawCheck of value.checks) {
    if (!isPlainObject(rawCheck)) return fail("audit check must be an object");
    if (
      typeof rawCheck.id !== "string" ||
      !(AUDIT_CHECK_IDS as readonly string[]).includes(rawCheck.id)
    ) {
      return fail("audit check id is invalid");
    }
    if (
      typeof rawCheck.status !== "string" ||
      !(AUDIT_CHECK_STATUSES as readonly string[]).includes(rawCheck.status)
    ) {
      return fail("audit check status is invalid");
    }
    const check: AuditCheck = {
      id: rawCheck.id as AuditCheckId,
      label: typeof rawCheck.label === "string" ? rawCheck.label : rawCheck.id,
      status: rawCheck.status as AuditCheckStatus,
    };
    if (typeof rawCheck.detail === "string" && rawCheck.detail !== "")
      check.detail = rawCheck.detail;
    checks.push(check);
  }

  return ok({ verdict: value.verdict as AuditVerdict, checks });
}

function check(
  id: AuditCheckId,
  label: string,
  status: AuditCheckStatus,
  detail?: string,
): AuditCheck {
  return detail === undefined ? { id, label, status } : { id, label, status, detail };
}

function contentShimCheck(
  content: ContentRuntimeState,
  generation: number,
  timezone: string | undefined,
): AuditCheck {
  if (typeof content.frameCount === "number") {
    const frameCount = content.frameCount;
    const currentFrameCount = content.currentFrameCount ?? 0;
    const activeNote =
      content.activeTabId === undefined || content.activeTabId === null
        ? ""
        : content.activeTabCurrent === true
          ? "Active tab matches. "
          : "Active tab is stale or missing. ";
    if (frameCount === 0 || !content.hasShim) {
      return check(
        "content_shim",
        "Page shim",
        "unavailable",
        "No page shim has reported from an open tab.",
      );
    }
    const matched = currentFrameCount === frameCount;
    return check(
      "content_shim",
      "Page shim",
      matched ? "ok" : "stale",
      `${activeNote}${currentFrameCount} of ${frameCount} frames match generation ${generation}.`,
    );
  }

  const contentStatus: AuditCheckStatus =
    !content.hasShim || content.reportedGeneration === null
      ? "unavailable"
      : content.reportedGeneration === generation && content.reportedTimezone === timezone
        ? "ok"
        : "stale";
  return check(
    "content_shim",
    "Page shim",
    contentStatus,
    !content.hasShim
      ? "No page shim has reported from an open tab."
      : content.reportedGeneration === null
        ? "A page shim is present but has not reported yet."
        : contentStatus === "ok"
          ? `reported generation ${content.reportedGeneration}`
          : `page reports generation ${content.reportedGeneration} (${content.reportedTimezone ?? "no timezone"})`,
  );
}

function hasGeoDetail(identity: ResolvedIdentity): boolean {
  return (
    identity.countryCode !== undefined ||
    identity.region !== undefined ||
    identity.city !== undefined ||
    identity.latitude !== undefined
  );
}

function locationStatus(identity: ResolvedIdentity, providerFailed: boolean): AuditCheckStatus {
  if (identity.source === "manual") return "manual";
  if (providerFailed) return "provider_error";
  return "ok";
}

export function buildAuditReport(input: AuditInput): AuditReport {
  const { identity, proxy, webrtc, content, firefoxProxy } = input;

  const firefoxProxyCheck: AuditCheck =
    firefoxProxy.proxyType === "none"
      ? check(
          "firefox_proxy",
          "Firefox proxy settings",
          "ok",
          "No Firefox-level proxy is configured.",
        )
      : firefoxProxy.levelOfControl === "controlled_by_other_extensions" ||
          firefoxProxy.levelOfControl === "controlled_by_this_extension"
        ? check(
            "firefox_proxy",
            "Firefox proxy settings",
            firefoxProxy.levelOfControl === "controlled_by_other_extensions"
              ? "controlled_by_other_extension"
              : "unavailable",
            `Firefox reports proxyType=${firefoxProxy.proxyType} (${firefoxProxy.levelOfControl}). This extension routes requests itself and does not rewrite that setting.`,
          )
        : check(
            "firefox_proxy",
            "Firefox proxy settings",
            "unavailable",
            `Firefox reports its own proxy configuration (proxyType=${firefoxProxy.proxyType}). A "direct" profile does not override Firefox's manual proxy settings.`,
          );

  if (input.activeProfileId === null) {
    return {
      verdict: "inactive",
      checks: [
        check("proxy", "Proxy configured", "not_configured", "No profile is active."),
        check("public_ip", "Public egress IP resolved", "unavailable", "No profile is active."),
        check("geoip", "GeoIP resolved", "unavailable", "No profile is active."),
        check("timezone", "Timezone available", "unavailable", "No profile is active."),
        check("geolocation", "Geolocation available", "unavailable", "No profile is active."),
        check("webrtc", "WebRTC policy applied", "not_configured", "No profile is active."),
        check("content_shim", "Page shim", "unavailable", "No identity is being applied."),
        firefoxProxyCheck,
      ],
    };
  }

  const checks: AuditCheck[] = [];

  checks.push(
    proxy.configured
      ? check(
          "proxy",
          "Proxy configured",
          "ok",
          `${proxy.type.toUpperCase()} ${proxy.host ?? "?"}:${proxy.port ?? "?"}`,
        )
      : check(
          "proxy",
          "Proxy configured",
          "not_configured",
          "Direct connection: traffic is not proxied.",
        ),
  );

  if (identity.publicIp === undefined) {
    checks.push(
      check(
        "public_ip",
        "Public egress IP resolved",
        input.providerFailed ? "provider_error" : "unavailable",
        input.providerFailed ? "The GeoIP provider failed." : "No public IP is known yet.",
      ),
    );
  } else if (input.providerFailed) {
    checks.push(
      check(
        "public_ip",
        "Public egress IP resolved",
        "provider_error",
        "The configured public IP could not be verified.",
      ),
    );
  } else {
    checks.push(
      check(
        "public_ip",
        "Public egress IP resolved",
        identity.publicIpVerified ? "ok" : "pending",
        identity.publicIpVerified
          ? `${identity.publicIp} (observed at the proxy egress)`
          : `${identity.publicIp} (configured manually)`,
      ),
    );
  }

  checks.push(
    hasGeoDetail(identity)
      ? check(
          "geoip",
          "GeoIP resolved",
          locationStatus(identity, input.providerFailed),
          identity.city ?? identity.region ?? identity.countryCode ?? undefined,
        )
      : check(
          "geoip",
          "GeoIP resolved",
          input.providerFailed ? "provider_error" : "unavailable",
          input.providerFailed
            ? "The GeoIP provider failed."
            : "The provider returned no location data.",
        ),
  );

  checks.push(
    identity.timezone === undefined
      ? check(
          "timezone",
          "Timezone available",
          input.providerFailed ? "provider_error" : "unavailable",
          input.providerFailed ? "The GeoIP provider failed." : "No timezone is available.",
        )
      : check("timezone", "Timezone available", locationStatus(identity, false), identity.timezone),
  );

  checks.push(
    identity.latitude === undefined || identity.longitude === undefined
      ? check(
          "geolocation",
          "Geolocation available",
          input.providerFailed ? "provider_error" : "unavailable",
          input.providerFailed ? "The GeoIP provider failed." : "No coordinates are available.",
        )
      : check(
          "geolocation",
          "Geolocation available",
          locationStatus(identity, false),
          `${identity.latitude.toFixed(3)}, ${identity.longitude.toFixed(3)} ±${Math.round(identity.accuracy ?? 0)} m`,
        ),
  );

  const webrtcStatus: AuditCheckStatus =
    webrtc.status === "applied" || webrtc.status === "already"
      ? "ok"
      : webrtc.status === "controlled_by_other" || webrtc.status === "not_controllable"
        ? "controlled_by_other_extension"
        : webrtc.status === "error"
          ? "error"
          : webrtc.status === "unsupported"
            ? "unavailable"
            : input.status === "activating" || input.status === "resolving"
              ? "pending"
              : "unavailable";
  checks.push(
    check(
      "webrtc",
      "WebRTC policy applied",
      webrtcStatus,
      webrtc.message ??
        `requested ${webrtc.desired}${webrtc.actual === undefined ? "" : `, effective ${webrtc.actual}`}`,
    ),
  );

  checks.push(contentShimCheck(content, input.generation, identity.timezone));

  checks.push(firefoxProxyCheck);

  const verdict: AuditVerdict = checks.some((entry) => entry.status === "error")
    ? "error"
    : checks.some((entry) =>
          [
            "unavailable",
            "provider_error",
            "controlled_by_other_extension",
            "stale",
            "pending",
          ].includes(entry.status),
        )
      ? "partial"
      : "consistent";

  return { verdict, checks };
}

/** Narrow helper used by tests and diagnostics. */
export function countChecksByStatus(report: AuditReport): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of report.checks) {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  }
  return counts;
}
