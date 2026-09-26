/**
 * Proxy routing engine.
 *
 * Uses Firefox's native `browser.proxy.onRequest` instead of rewriting the global
 * Firefox proxy settings. That keeps the rest of the browser configuration
 * untouched (and reversible) and lets every request be decided per generation.
 *
 * Firefox facts this module depends on (verified against MDN):
 *   - `proxy.onRequest` may return a ProxyInfo, an array (failover) or a Promise.
 *   - `{ type: "direct" }` does *not* override a user-configured Firefox proxy, so
 *     the audit reports Firefox's own proxy configuration separately.
 *   - `username`/`password` are only honoured for `socks` (SOCKS5). HTTP/HTTPS
 *     proxy authentication goes through `proxyAuthorizationHeader` (preemptive) or
 *     `webRequest.onAuthRequired` (challenge based).
 *   - `proxyDNS` is only honoured for `socks4`/`socks`.
 *   - SOCKS4 has no authentication support at all.
 *
 * Nothing here is async and no credentials are ever logged.
 */
import { DEFAULT_BYPASS_HOSTS } from "../shared/constants";
import { normalizeHost, shouldBypassHost } from "../shared/primitives";
import {
  isProxied,
  type IdentityProfile,
  type ProxyConfig,
  type ProxyType,
} from "../profile/schema";
import type { ProxyCredentials } from "../profile/validation";

export interface ActiveProxyTarget {
  profileId: string;
  profileName: string;
  generation: number;
  proxy: ProxyConfig;
  credentials: ProxyCredentials | null;
}

/** True when Firefox can use credentials for this proxy type. */
export function credentialsSupported(proxyType: ProxyType): boolean {
  return proxyType === "socks5" || proxyType === "http" || proxyType === "https";
}

/**
 * UTF-8 safe Basic credential encoding. `btoa` alone throws on non-ASCII input,
 * which would make proxy authentication fail for non-ASCII passwords.
 */
export function encodeBasicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

/** Maps the profile's proxy type onto Firefox's `ProxyInfo` shapes. */
export function buildProxyInfo(
  proxy: ProxyConfig,
  credentials: ProxyCredentials | null,
): browser.proxy.ProxyInfo {
  if (!isProxied(proxy)) return { type: "direct" };

  const host = proxy.host ?? "";
  const port = proxy.port ?? 0;

  switch (proxy.type) {
    case "http":
    case "https": {
      const info: browser.proxy.ProxyInfo = { type: proxy.type, host, port };
      // Preemptive authentication: works for proxies that do not need a challenge.
      // Challenge-based proxies are covered by webRequest.onAuthRequired.
      if (credentials !== null && credentials.username !== "") {
        info.proxyAuthorizationHeader = encodeBasicAuthorization(
          credentials.username,
          credentials.password,
        );
      }
      return info;
    }
    case "socks5": {
      const info: browser.proxy.ProxyInfo = { type: "socks", host, port, proxyDNS: proxy.proxyDNS };
      if (credentials !== null) {
        info.username = credentials.username;
        info.password = credentials.password;
      }
      return info;
    }
    case "socks4":
      // Firefox's socks4 ProxyInfo supports neither credentials nor DNS proxying
      // semantics beyond proxyDNS; credentials are intentionally not attached.
      return { type: "socks4", host, port, proxyDNS: proxy.proxyDNS };
    case "direct":
      return { type: "direct" };
  }
}

export interface ParsedRequestUrl {
  scheme: "http" | "https" | "ws" | "wss";
  hostname: string;
}

/**
 * Schemes that carry ordinary network traffic and must follow the active proxy.
 * `ws`/`wss` are included so a page cannot leave the proxy by opening a WebSocket.
 * Extension, `about:`, `file:`, `data:` and other internal URLs stay direct.
 */
function networkScheme(protocol: string): ParsedRequestUrl["scheme"] | null {
  switch (protocol) {
    case "http:":
      return "http";
    case "https:":
      return "https";
    case "ws:":
      return "ws";
    case "wss:":
      return "wss";
    default:
      return null;
  }
}

/** http(s) and ws(s) are routed; extension, about and file URLs stay direct. */
export function parseRequestUrl(url: string): ParsedRequestUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const scheme = networkScheme(parsed.protocol);
  if (scheme === null) return null;
  if (parsed.hostname === "") return null;
  return { scheme, hostname: normalizeHost(parsed.hostname) };
}

/**
 * Decides the proxy for one request. Pure, synchronous and side effect free.
 * Without an active target everything is direct, which is also what happens while
 * a profile is being activated.
 */
export function decideProxy(
  target: ActiveProxyTarget | null,
  url: string,
): browser.proxy.ProxyInfo {
  if (target === null) return { type: "direct" };
  const parsed = parseRequestUrl(url);
  if (parsed === null) return { type: "direct" };

  const bypassEntries = [...DEFAULT_BYPASS_HOSTS, ...target.proxy.bypassHosts];
  // The GeoIP endpoint is deliberately never bypassed: it must observe the proxy
  // egress address for the identity to be real.
  if (shouldBypassHost(parsed.hostname, bypassEntries)) return { type: "direct" };

  return buildProxyInfo(target.proxy, target.credentials);
}

export interface ProxyAuthChallenge {
  isProxy: boolean;
  challengerHost?: string | undefined;
  challengerPort?: number | undefined;
}

export interface ProxyAuthCredentials {
  username: string;
  password: string;
}

/**
 * Strict matching for `webRequest.onAuthRequired`.
 *
 * Credentials are returned only when *all* of the following hold:
 *   1. Firefox reports the challenge came from a proxy (`isProxy`).
 *   2. The active profile is an HTTP/HTTPS proxy with stored credentials.
 *   3. The challenger host and port are both present and both match. A same-port
 *      challenge from a different host, or a missing field, fails closed.
 *
 * Origin (`WWW-Authenticate`) challenges therefore can never receive proxy
 * credentials. Callers must also use {@link createAuthAttemptTracker} so a wrong
 * password cannot be replayed on the same request.
 */
export function decideProxyAuth(
  target: ActiveProxyTarget | null,
  challenge: ProxyAuthChallenge,
): ProxyAuthCredentials | null {
  if (target === null) return null;
  if (challenge.isProxy !== true) return null;
  if (target.proxy.type !== "http" && target.proxy.type !== "https") return null;

  const credentials = target.credentials;
  if (credentials === null) return null;
  if (target.proxy.host === undefined || target.proxy.port === undefined) return null;
  if (challenge.challengerHost === undefined || challenge.challengerPort === undefined) {
    return null;
  }

  const proxyHost = normalizeHost(target.proxy.host);
  const challengerHost = normalizeHost(challenge.challengerHost);
  if (challengerHost === "" || challengerHost !== proxyHost) return null;
  if (challenge.challengerPort !== target.proxy.port) return null;

  return { username: credentials.username, password: credentials.password };
}

/**
 * Remembers which webRequest ids have already been offered proxy credentials.
 *
 * A second `407` on the same request means the previous answer was rejected.
 * Returning credentials again would loop. The id is released when the request
 * completes or errors, and the map is capped so a missing completion event
 * cannot grow without bound.
 */
export function createAuthAttemptTracker(limit = 256): {
  claim(requestId: string): boolean;
  release(requestId: string): void;
} {
  const answered = new Map<string, true>();
  return {
    claim(requestId: string): boolean {
      if (requestId === "") return false;
      if (answered.has(requestId)) return false;
      answered.set(requestId, true);
      while (answered.size > limit) {
        const oldest = answered.keys().next().value;
        if (oldest === undefined) break;
        answered.delete(oldest);
      }
      return true;
    },
    release(requestId: string): void {
      answered.delete(requestId);
    },
  };
}

export interface FirefoxProxySettingsLike {
  get(details: { incognito?: boolean }): Promise<{ value: unknown; levelOfControl: string }>;
}

export interface FirefoxProxySettingsSnapshot {
  proxyType: string;
  levelOfControl: string;
}

/**
 * Reads Firefox's own proxy configuration.
 *
 * This exists purely for honesty in the audit: a `direct` profile does not
 * override Firefox's manual proxy settings, and another proxy extension may be in
 * control. net-identity never writes this setting.
 */
export async function readFirefoxProxySettings(
  setting: FirefoxProxySettingsLike,
): Promise<FirefoxProxySettingsSnapshot> {
  try {
    const current = await setting.get({});
    const value = current.value;
    const proxyType =
      typeof value === "object" &&
      value !== null &&
      typeof (value as { proxyType?: unknown }).proxyType === "string"
        ? String((value as { proxyType: string }).proxyType)
        : "unknown";
    const levelOfControl =
      typeof current.levelOfControl === "string" && current.levelOfControl !== ""
        ? current.levelOfControl
        : "unknown";
    return { proxyType, levelOfControl };
  } catch {
    return { proxyType: "unknown", levelOfControl: "unknown" };
  }
}

/** Used by tests and diagnostics; never includes credentials. */
export function isDirectProfile(profile: IdentityProfile): boolean {
  return profile.proxy.type === "direct";
}
