/**
 * Primitive validators and normalisers.
 *
 * Everything here is pure, dependency-free and unit tested. Profile validation,
 * provider response validation and UI form validation all build on these helpers,
 * so a value is described in exactly one place.
 */
import { MAX_BYPASS_ENTRY_LENGTH, MAX_HOST_LENGTH, MAX_PROFILE_NAME_LENGTH } from "./constants";
import { fail, isPlainObject, ok, type Result } from "./result";

import type { IdentityMode, ProxyType, WebRTCPolicy } from "../profile/schema";

const IPV4_PATTERN =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export const PROXY_TYPES: readonly ProxyType[] = ["direct", "http", "https", "socks4", "socks5"];
export const WEBRTC_POLICIES: readonly WebRTCPolicy[] = [
  "default",
  "default_public_interface_only",
  "disable_non_proxied_udp",
  "proxy_only",
];
export const IDENTITY_MODES: readonly IdentityMode[] = ["auto", "manual"];

export function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

export function trimToLength(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * WHATWG URL parsing is used as the oracle for IPv6 literals: it implements the
 * same strict grammar that Firefox uses, so there is no hand-rolled regex to drift.
 */
export function isIpv6Address(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const bare = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (bare.length === 0 || !bare.includes(":")) return false;
  try {
    return new URL(`http://[${bare}]/`).hostname.startsWith("[");
  } catch {
    return false;
  }
}

export function isIpv4Address(value: unknown): boolean {
  return typeof value === "string" && IPV4_PATTERN.test(value);
}

export function isIpAddress(value: unknown): boolean {
  return isIpv4Address(value) || isIpv6Address(value);
}

/** Accepts hostnames, IPv4/IPv6 literals and bracketed IPv6 literals. */
export function isValidHost(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > MAX_HOST_LENGTH) return false;
  if (candidate.startsWith("[") || candidate.endsWith("]")) {
    return candidate.startsWith("[") && candidate.endsWith("]") && isIpv6Address(candidate);
  }
  if (isIpv4Address(candidate) || isIpv6Address(candidate)) return true;
  // All-numeric dotted strings are meant as IP addresses. Rejecting the invalid
  // ones ("01.2.3.4", "999.1.1.1") avoids silently treating a typo as a hostname,
  // and matches how browsers parse hosts.
  if (/^[0-9.]+$/.test(candidate)) return false;
  return HOSTNAME_PATTERN.test(candidate);
}

export function isValidPort(value: unknown): value is number {
  return isIntegerInRange(value, 1, 65535);
}

/** Lower-cases and strips the brackets/trailing dot from a host for comparison. */
export function normalizeHost(value: string): string {
  let host = value.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

export function parseProxyType(value: unknown): Result<ProxyType> {
  if (typeof value === "string" && (PROXY_TYPES as readonly string[]).includes(value)) {
    return ok(value as ProxyType);
  }
  return fail(`proxy type must be one of: ${PROXY_TYPES.join(", ")}`);
}

export function parseWebRtcPolicy(value: unknown): Result<WebRTCPolicy> {
  if (typeof value === "string" && (WEBRTC_POLICIES as readonly string[]).includes(value)) {
    return ok(value as WebRTCPolicy);
  }
  return fail(`WebRTC policy must be one of: ${WEBRTC_POLICIES.join(", ")}`);
}

export function parseIdentityMode(value: unknown): Result<IdentityMode> {
  if (typeof value === "string" && (IDENTITY_MODES as readonly string[]).includes(value)) {
    return ok(value as IdentityMode);
  }
  return fail(`identity mode must be one of: ${IDENTITY_MODES.join(", ")}`);
}

export function normalizeProfileName(value: unknown): string | null {
  if (!isNonEmptyString(value, MAX_PROFILE_NAME_LENGTH * 2)) return null;
  const name = trimToLength(value, MAX_PROFILE_NAME_LENGTH);
  return name === "" ? null : name;
}

function isIpv4Cidr(entry: string): boolean {
  const [address, prefix] = entry.split("/");
  if (address === undefined || prefix === undefined) return false;
  if (!isIpv4Address(address)) return false;
  const bits = Number(prefix);
  return Number.isInteger(bits) && bits >= 0 && bits <= 32;
}

/**
 * Bypass entries support the forms Firefox users expect from a proxy exclusion
 * list: a bare host, a `*.example.com` wildcard, an IP literal and an IPv4 CIDR.
 */
export function isValidBypassEntry(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const entry = value.trim();
  if (entry.length === 0 || entry.length > MAX_BYPASS_ENTRY_LENGTH) return false;
  if (entry.includes("/")) return isIpv4Cidr(entry);
  if (entry.startsWith("*.")) return isValidHost(entry.slice(2));
  return isValidHost(entry);
}

export function parseBypassEntry(value: unknown): Result<string> {
  if (!isValidBypassEntry(value)) {
    return fail(
      "bypass entries must be a host, *.domain, IP address or IPv4 CIDR range (for example localhost, *.example.com, 10.0.0.0/8)",
    );
  }
  return ok((value as string).trim().toLowerCase());
}

export function parseBypassHosts(value: unknown, maxEntries: number): Result<string[]> {
  if (value === undefined) return ok([]);
  if (!Array.isArray(value)) return fail("bypass hosts must be a list");
  if (value.length > maxEntries) return fail(`too many bypass entries (max ${maxEntries})`);
  const entries: string[] = [];
  for (const candidate of value) {
    const parsed = parseBypassEntry(candidate);
    if (!parsed.ok) return fail(...parsed.errors);
    if (!entries.includes(parsed.value)) entries.push(parsed.value);
  }
  return ok(entries);
}

export function ipv4ToInteger(address: string): number | null {
  if (!isIpv4Address(address)) return null;
  const parts = address.split(".").map((part) => Number(part));
  const [a, b, c, d] = parts;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

export function isIpv4InCidr(address: string, cidr: string): boolean {
  const [network, prefix] = cidr.split("/");
  if (network === undefined || prefix === undefined) return false;
  const addressValue = ipv4ToInteger(address);
  const networkValue = ipv4ToInteger(network);
  const bits = Number(prefix);
  if (addressValue === null || networkValue === null || !Number.isInteger(bits)) return false;
  if (bits === 0) return true;
  if (bits > 32 || bits < 0) return false;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (addressValue & mask) === (networkValue & mask);
}

/** True when `entry` matches `host` following Firefox's "no proxy for" semantics. */
export function bypassEntryMatchesHost(entry: string, host: string): boolean {
  const normalizedEntry = entry.trim().toLowerCase();
  const normalizedHost = normalizeHost(host);
  if (normalizedEntry === "" || normalizedHost === "") return false;

  if (normalizedEntry.includes("/")) {
    return isIpv4InCidr(normalizedHost, normalizedEntry);
  }

  if (normalizedEntry.startsWith("*.")) {
    const suffix = normalizedEntry.slice(1);
    return normalizedHost.endsWith(suffix) || normalizedHost === normalizedEntry.slice(2);
  }

  if (isIpAddress(normalizedEntry)) {
    return normalizeHost(normalizedEntry) === normalizedHost;
  }

  return normalizedHost === normalizedEntry || normalizedHost.endsWith(`.${normalizedEntry}`);
}

export function shouldBypassHost(host: string, entries: readonly string[]): boolean {
  return entries.some((entry) => bypassEntryMatchesHost(entry, host));
}

export function isPlainObjectOrNull(value: unknown): value is Record<string, unknown> | null {
  return value === null || isPlainObject(value);
}
