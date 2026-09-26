/**
 * Pure form mapping for the options page.
 *
 * Keeping this free of DOM access means the tricky part (turning user text into a
 * profile-shaped object) is unit tested, while `options.ts` stays a thin layer of
 * element wiring. The output is still validated by `parseProfile` before it is
 * saved, so the form cannot bypass domain rules.
 *
 * The password is never part of the profile shape: it is returned separately so it
 * can be routed to session storage only.
 */
import type { IdentityProfile } from "../profile/schema";

export interface ProfileFormValues {
  id: string | undefined;
  name: string;
  proxyType: string;
  proxyHost: string;
  proxyPort: string;
  proxyUsername: string;
  password: string;
  removeCredentials: boolean;
  proxyDns: boolean;
  bypassHosts: string;
  identityMode: string;
  latitude: string;
  longitude: string;
  accuracy: string;
  timezone: string;
  webrtcPolicy: string;
}

export type CredentialsIntent =
  { action: "keep" } | { action: "clear" } | { action: "set"; username: string; password: string };

export function parseBypassHostsInput(value: string): string[] {
  return value
    .split(/[\n,;]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
}

export function formatBypassHostsInput(hosts: readonly string[]): string {
  return hosts.join("\n");
}

function toNumberOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Builds the object handed to `parseProfile`. Unknown text such as "" is omitted. */
export function toProfileInput(values: ProfileFormValues, fallbackId: string): unknown {
  const isDirect = values.proxyType === "direct";
  const mode = values.identityMode === "manual" ? "manual" : "auto";
  const username = values.proxyUsername.trim();

  const proxy: Record<string, unknown> = {
    type: values.proxyType,
    proxyDNS: values.proxyDns,
    bypassHosts: parseBypassHostsInput(values.bypassHosts),
  };
  if (!isDirect) {
    proxy.host = values.proxyHost.trim();
    proxy.port = toNumberOrUndefined(values.proxyPort);
  }
  if (!isDirect && username !== "") proxy.username = username;

  const identity: Record<string, unknown> = { mode };
  if (mode === "manual") {
    identity.latitude = toNumberOrUndefined(values.latitude);
    identity.longitude = toNumberOrUndefined(values.longitude);
    identity.accuracy = toNumberOrUndefined(values.accuracy);
    identity.timezone = values.timezone.trim();
  }

  return {
    id: values.id ?? fallbackId,
    name: values.name.trim(),
    proxy,
    identity,
    webrtcPolicy: values.webrtcPolicy,
  };
}

/**
 * Decides what to do with the stored session credentials for a save.
 *
 * The password input is always empty when loaded, so:
 *   - a typed password means "replace the stored credentials"
 *   - the remove checkbox means "forget them"
 *   - otherwise the stored value (if any) is left untouched
 */
export function credentialsIntentFrom(values: ProfileFormValues): CredentialsIntent {
  if (values.removeCredentials) return { action: "clear" };
  if (values.password !== "") {
    return { action: "set", username: values.proxyUsername.trim(), password: values.password };
  }
  return { action: "keep" };
}

/**
 * Projects a stored profile onto the form fields. The password is never part of a
 * stored profile, so the field always starts empty.
 */
export function toFormValues(profile: IdentityProfile | null): ProfileFormValues {
  if (profile === null) {
    return {
      id: undefined,
      name: "",
      proxyType: "http",
      proxyHost: "",
      proxyPort: "8080",
      proxyUsername: "",
      password: "",
      removeCredentials: false,
      proxyDns: false,
      bypassHosts: "localhost\n127.0.0.1\n::1",
      identityMode: "auto",
      latitude: "",
      longitude: "",
      accuracy: "1000",
      timezone: "",
      webrtcPolicy: "disable_non_proxied_udp",
    };
  }

  return {
    id: profile.id,
    name: profile.name,
    proxyType: profile.proxy.type,
    proxyHost: profile.proxy.host ?? "",
    proxyPort: profile.proxy.port === undefined ? "" : String(profile.proxy.port),
    proxyUsername: profile.proxy.username ?? "",
    password: "",
    removeCredentials: false,
    proxyDns: profile.proxy.proxyDNS,
    bypassHosts: formatBypassHostsInput(profile.proxy.bypassHosts),
    identityMode: profile.identity.mode,
    latitude: profile.identity.latitude === undefined ? "" : String(profile.identity.latitude),
    longitude: profile.identity.longitude === undefined ? "" : String(profile.identity.longitude),
    accuracy: profile.identity.accuracy === undefined ? "1000" : String(profile.identity.accuracy),
    timezone: profile.identity.timezone ?? "",
    webrtcPolicy: profile.webrtcPolicy,
  };
}

export function isCredentialsSupported(proxyType: string): boolean {
  return proxyType === "http" || proxyType === "https" || proxyType === "socks5";
}

/** Explanation shown next to the proxy fields; mirrors what Firefox actually does. */
export function proxyFieldHints(proxyType: string): string[] {
  const hints: string[] = [];
  if (proxyType === "socks4") {
    hints.push(
      "Firefox does not support authentication for SOCKS4 proxies, so a username and password are ignored.",
    );
  }
  if (proxyType === "http" || proxyType === "https") {
    hints.push(
      "HTTP/HTTPS proxy credentials are sent as a preemptive Basic header and, when the proxy demands a challenge, answered only for this proxy.",
    );
  }
  if (proxyType === "socks5") {
    hints.push("SOCKS5 credentials are passed to Firefox as SOCKS authentication.");
  }
  hints.push(
    "Proxy DNS routes name resolution through the proxy. Firefox applies this to SOCKS proxies only.",
  );
  return hints;
}
