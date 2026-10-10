/** Local-only endpoint parsing. Never probes a server or echoes pasted secrets. */
import { isIpv6Address, isValidHost, normalizeHost } from "../shared/primitives";
import { fail, ok, type Result } from "../shared/result";
import { createProfile, type IdentityProfile, type ProxyType } from "./schema";
import { parseProfile } from "./validation";
import { MAX_PROFILES, MAX_PROFILE_NAME_LENGTH } from "../shared/constants";

export type QuickProxyType = Exclude<ProxyType, "direct">;
export interface QuickEndpoint {
  type: QuickProxyType;
  host: string;
  port: number;
}
export const MAX_QUICK_ENDPOINT_LENGTH = 1024;

/** Explicit schemes override the visible default. URL credentials are intentionally refused. */
export function parseQuickEndpoint(
  input: string,
  portInput: string,
  defaultType: QuickProxyType,
): Result<QuickEndpoint> {
  if (input.length > MAX_QUICK_ENDPOINT_LENGTH || portInput.length > 5)
    return fail("Endpoint is too long.");
  const text = input.trim();
  if (!text || /\s/.test(text)) return fail("Enter a host without whitespace.");
  if (text.includes("@"))
    return fail("Remove credentials from the address and use the separate authentication fields.");
  if (text.includes("%"))
    return fail("Percent-encoded endpoints are not supported. Enter the host directly.");
  let type = defaultType;
  let authority = text;
  const schemeEnd = text.indexOf("://");
  if (schemeEnd >= 0) {
    const scheme = text.slice(0, schemeEnd).toLowerCase();
    if (scheme !== "http" && scheme !== "https" && scheme !== "socks4" && scheme !== "socks5")
      return fail("Choose HTTP, HTTPS, SOCKS4 or SOCKS5.");
    type = scheme;
    authority = text.slice(schemeEnd + 3);
  }
  if (/[/?#\\]/.test(authority))
    return fail("Enter only a proxy host and port, without a path or query.");
  let host = authority;
  let inlinePort: string | undefined;
  if (authority.startsWith("[")) {
    const closing = authority.indexOf("]");
    if (closing < 0) return fail("Close the IPv6 address with ].");
    host = authority.slice(0, closing + 1);
    const suffix = authority.slice(closing + 1);
    if (suffix !== "") {
      if (!suffix.startsWith(":")) return fail("Use [IPv6]:port.");
      inlinePort = suffix.slice(1);
    }
  } else if (authority.includes(":")) {
    if (authority.indexOf(":") !== authority.lastIndexOf(":"))
      return fail("Wrap an IPv6 address in brackets, for example [::1]:1080.");
    [host = "", inlinePort] = authority.split(":");
  }
  if (!isValidHost(host)) return fail("Enter a valid hostname, IPv4 or bracketed IPv6 address.");
  const portText = inlinePort ?? portInput;
  if (!/^[0-9]{1,5}$/.test(portText)) return fail("Enter a port from 1 to 65535.");
  const port = Number(portText);
  if (port < 1 || port > 65535) return fail("Enter a port from 1 to 65535.");
  // Canonicalize IPv6 for duplicate detection without DNS or network access.
  const normalized = isIpv6Address(host)
    ? normalizeHost(new URL(`http://${host}/`).hostname)
    : normalizeHost(host);
  return ok({ type, host: normalized, port });
}

export function quickProxyProfile(
  endpoint: QuickEndpoint,
  name: string,
  id: string,
  existing: readonly IdentityProfile[],
): Result<IdentityProfile> {
  if (existing.filter((profile) => profile.id !== "builtin-direct").length >= MAX_PROFILES)
    return fail("The profile limit has been reached.");
  const taken = new Set(existing.map((profile) => profile.name.toLowerCase()));
  let chosen = name.trim();
  if (chosen.length > MAX_PROFILE_NAME_LENGTH) return fail("Profile name is too long.");
  if (chosen && taken.has(chosen.toLowerCase()))
    return fail("That profile name is already used. Choose another name.");
  if (!chosen) {
    const base = `${endpoint.type.toUpperCase()} ${endpoint.host}:${String(endpoint.port)}`.slice(
      0,
      MAX_PROFILE_NAME_LENGTH - 8,
    );
    chosen = base;
    let suffix = 2;
    while (taken.has(chosen.toLowerCase())) chosen = `${base} (${String(suffix++)})`;
  }
  const profile = createProfile(id, chosen, endpoint.type);
  profile.proxy.host = endpoint.host;
  profile.proxy.port = endpoint.port;
  return parseProfile(profile);
}
