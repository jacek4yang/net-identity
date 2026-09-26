/**
 * The UI-facing runtime state.
 *
 * This is the single source of truth the popup and options pages render. It is
 * produced by the background script and parsed again on arrival, so a bug in one
 * side cannot silently corrupt the other.
 *
 * The state contains no secrets: proxy credentials are represented by a boolean.
 */
import { isFiniteNumber, isIntegerInRange, isValidHost, isValidPort } from "./primitives";
import { parseProxyType, parseWebRtcPolicy } from "./primitives";
import { fail, isPlainObject, ok, type Result } from "./result";
import { isValidTimeZone } from "./timezone";
import { parseAuditReport, type AuditReport } from "./audit";

import type { ProxyType, WebRTCPolicy } from "../profile/schema";

export type RuntimeStatus = "idle" | "activating" | "resolving" | "ready" | "error";

export const RUNTIME_STATUSES: readonly RuntimeStatus[] = [
  "idle",
  "activating",
  "resolving",
  "ready",
  "error",
];

export type WebRtcApplyStatus =
  | "pending"
  | "applied"
  | "already"
  | "controlled_by_other"
  | "not_controllable"
  | "unsupported"
  | "error";

export const WEBRTC_APPLY_STATUSES: readonly WebRtcApplyStatus[] = [
  "pending",
  "applied",
  "already",
  "controlled_by_other",
  "not_controllable",
  "unsupported",
  "error",
];

export interface ResolvedIdentity {
  source: "auto" | "manual";
  /** IP that the extension believes the site sees. */
  publicIp?: string;
  /** IP actually observed by the GeoIP provider through the active proxy. */
  observedIp?: string;
  /** True when the observed egress address matched the believed public IP. */
  publicIpVerified: boolean;
  countryCode?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  timezone?: string;
  resolvedAt?: number;
  provider?: string;
}

export interface ProxyRuntimeSummary {
  configured: boolean;
  type: ProxyType;
  host?: string;
  port?: number;
  proxyDns: boolean;
  bypassCount: number;
  /** Whether a session-scoped password exists. The value itself never leaves storage. */
  hasCredentials: boolean;
}

export interface WebRtcRuntimeState {
  desired: WebRTCPolicy;
  actual?: string;
  levelOfControl: string;
  status: WebRtcApplyStatus;
  message?: string;
}

export interface FirefoxProxyRuntimeState {
  /** Firefox's own proxy configuration, which this extension does not rewrite. */
  proxyType: string;
  levelOfControl: string;
}

export interface ContentRuntimeState {
  hasShim: boolean;
  reportedGeneration: number | null;
  reportedTimezone?: string;
  url?: string;
}

export interface RuntimeErrorInfo {
  code: string;
  message: string;
}

export interface RuntimeState {
  status: RuntimeStatus;
  generation: number;
  activeProfileId: string | null;
  activeProfileName: string | null;
  proxy: ProxyRuntimeSummary;
  identity: ResolvedIdentity;
  webrtc: WebRtcRuntimeState;
  firefoxProxy: FirefoxProxyRuntimeState;
  content: ContentRuntimeState;
  audit: AuditReport;
  lastError?: RuntimeErrorInfo;
  updatedAt: number;
}

export function createInitialRuntimeState(now: number): RuntimeState {
  return {
    status: "idle",
    generation: 0,
    activeProfileId: null,
    activeProfileName: null,
    proxy: {
      configured: false,
      type: "direct",
      proxyDns: false,
      bypassCount: 0,
      hasCredentials: false,
    },
    identity: { source: "auto", publicIpVerified: false },
    webrtc: { desired: "default", levelOfControl: "unknown", status: "pending" },
    firefoxProxy: { proxyType: "unknown", levelOfControl: "unknown" },
    content: { hasShim: false, reportedGeneration: null },
    audit: { verdict: "inactive", checks: [] },
    updatedAt: now,
  };
}

export interface RuntimeStateInput {
  status: RuntimeStatus;
  generation: number;
  activeProfileId: string | null;
  activeProfileName: string | null;
  proxy: ProxyRuntimeSummary;
  identity: ResolvedIdentity;
  webrtc: WebRtcRuntimeState;
  firefoxProxy: FirefoxProxyRuntimeState;
  content: ContentRuntimeState;
  audit: AuditReport;
  lastError?: RuntimeErrorInfo | undefined;
  updatedAt: number;
}

export function createRuntimeState(input: RuntimeStateInput): RuntimeState {
  return {
    status: input.status,
    generation: input.generation,
    activeProfileId: input.activeProfileId,
    activeProfileName: input.activeProfileName,
    proxy: input.proxy,
    identity: input.identity,
    webrtc: input.webrtc,
    firefoxProxy: input.firefoxProxy,
    content: input.content,
    audit: input.audit,
    ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
    updatedAt: input.updatedAt,
  };
}

function readOptionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readOptionalNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return isFiniteNumber(value) ? value : undefined;
}

export function parseResolvedIdentity(value: unknown): Result<ResolvedIdentity> {
  if (!isPlainObject(value)) return fail("identity state must be an object");
  const source = value.source === "manual" ? "manual" : "auto";
  if (value.source !== "auto" && value.source !== "manual")
    return fail("identity source is invalid");

  const identity: ResolvedIdentity = {
    source,
    publicIpVerified: value.publicIpVerified === true,
  };
  const publicIp = readOptionalString(value, "publicIp");
  if (publicIp !== undefined) identity.publicIp = publicIp;
  const observedIp = readOptionalString(value, "observedIp");
  if (observedIp !== undefined) identity.observedIp = observedIp;
  const countryCode = readOptionalString(value, "countryCode");
  if (countryCode !== undefined) identity.countryCode = countryCode;
  const region = readOptionalString(value, "region");
  if (region !== undefined) identity.region = region;
  const city = readOptionalString(value, "city");
  if (city !== undefined) identity.city = city;
  const provider = readOptionalString(value, "provider");
  if (provider !== undefined) identity.provider = provider;

  const latitude = readOptionalNumber(value, "latitude");
  const longitude = readOptionalNumber(value, "longitude");
  if (
    latitude !== undefined &&
    longitude !== undefined &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  ) {
    identity.latitude = latitude;
    identity.longitude = longitude;
  }
  const accuracy = readOptionalNumber(value, "accuracy");
  if (accuracy !== undefined && accuracy > 0) identity.accuracy = accuracy;

  const timezone = readOptionalString(value, "timezone");
  if (timezone !== undefined && isValidTimeZone(timezone)) identity.timezone = timezone;

  const resolvedAt = readOptionalNumber(value, "resolvedAt");
  if (resolvedAt !== undefined) identity.resolvedAt = resolvedAt;

  return ok(identity);
}

function parseProxySummary(value: unknown): Result<ProxyRuntimeSummary> {
  if (!isPlainObject(value)) return fail("proxy state must be an object");
  const typeResult = parseProxyType(value.type);
  if (!typeResult.ok) return fail(...typeResult.errors);

  const summary: ProxyRuntimeSummary = {
    configured: value.configured === true,
    type: typeResult.value,
    proxyDns: value.proxyDns === true,
    bypassCount: isIntegerInRange(value.bypassCount, 0, 10000) ? value.bypassCount : 0,
    hasCredentials: value.hasCredentials === true,
  };
  const host = readOptionalString(value, "host");
  if (host !== undefined && isValidHost(host)) summary.host = host;
  const port = readOptionalNumber(value, "port");
  if (port !== undefined && isValidPort(port)) summary.port = port;
  return ok(summary);
}

export function parseWebRtcState(value: unknown): Result<WebRtcRuntimeState> {
  if (!isPlainObject(value)) return fail("WebRTC state must be an object");
  const desiredResult = parseWebRtcPolicy(value.desired);
  if (!desiredResult.ok) return fail(...desiredResult.errors);
  if (
    typeof value.status !== "string" ||
    !(WEBRTC_APPLY_STATUSES as readonly string[]).includes(value.status)
  ) {
    return fail("WebRTC status is invalid");
  }
  const state: WebRtcRuntimeState = {
    desired: desiredResult.value,
    levelOfControl: readOptionalString(value, "levelOfControl") ?? "unknown",
    status: value.status as WebRtcApplyStatus,
  };
  const actual = readOptionalString(value, "actual");
  if (actual !== undefined) state.actual = actual;
  const message = readOptionalString(value, "message");
  if (message !== undefined) state.message = message;
  return ok(state);
}

function parseFirefoxProxyState(value: unknown): Result<FirefoxProxyRuntimeState> {
  if (!isPlainObject(value)) return fail("Firefox proxy state must be an object");
  return ok({
    proxyType: readOptionalString(value, "proxyType") ?? "unknown",
    levelOfControl: readOptionalString(value, "levelOfControl") ?? "unknown",
  });
}

function parseContentState(value: unknown): Result<ContentRuntimeState> {
  if (!isPlainObject(value)) return fail("content state must be an object");
  const state: ContentRuntimeState = {
    hasShim: value.hasShim === true,
    reportedGeneration: isIntegerInRange(value.reportedGeneration, 0, Number.MAX_SAFE_INTEGER)
      ? value.reportedGeneration
      : null,
  };
  const timezone = readOptionalString(value, "reportedTimezone");
  if (timezone !== undefined && isValidTimeZone(timezone)) state.reportedTimezone = timezone;
  const url = readOptionalString(value, "url");
  if (url !== undefined) state.url = url;
  return ok(state);
}

export function parseRuntimeState(value: unknown): Result<RuntimeState> {
  if (!isPlainObject(value)) return fail("runtime state must be an object");
  if (
    typeof value.status !== "string" ||
    !(RUNTIME_STATUSES as readonly string[]).includes(value.status)
  ) {
    return fail("runtime status is invalid");
  }
  if (!isIntegerInRange(value.generation, 0, Number.MAX_SAFE_INTEGER)) {
    return fail("runtime generation is invalid");
  }

  const identityResult = parseResolvedIdentity(value.identity);
  if (!identityResult.ok) return fail(...identityResult.errors);
  const proxyResult = parseProxySummary(value.proxy);
  if (!proxyResult.ok) return fail(...proxyResult.errors);
  const webrtcResult = parseWebRtcState(value.webrtc);
  if (!webrtcResult.ok) return fail(...webrtcResult.errors);
  const firefoxProxyResult = parseFirefoxProxyState(value.firefoxProxy);
  if (!firefoxProxyResult.ok) return fail(...firefoxProxyResult.errors);
  const contentResult = parseContentState(value.content);
  if (!contentResult.ok) return fail(...contentResult.errors);
  const auditResult = parseAuditReport(value.audit);
  if (!auditResult.ok) return fail(...auditResult.errors);

  const activeProfileId = readOptionalString(value, "activeProfileId") ?? null;
  const activeProfileName = readOptionalString(value, "activeProfileName") ?? null;

  let lastError: RuntimeErrorInfo | undefined;
  if (isPlainObject(value.lastError)) {
    const message = readOptionalString(value.lastError, "message");
    const code = readOptionalString(value.lastError, "code");
    if (message !== undefined) lastError = { code: code ?? "error", message };
  }

  return ok(
    createRuntimeState({
      status: value.status as RuntimeStatus,
      generation: value.generation,
      activeProfileId,
      activeProfileName,
      proxy: proxyResult.value,
      identity: identityResult.value,
      webrtc: webrtcResult.value,
      firefoxProxy: firefoxProxyResult.value,
      content: contentResult.value,
      audit: auditResult.value,
      lastError,
      updatedAt: readOptionalNumber(value, "updatedAt") ?? 0,
    }),
  );
}
