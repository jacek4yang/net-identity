/**
 * The profile model.
 *
 * A profile binds one network identity together: proxy configuration, the observed
 * public egress identity and the browser-visible WebRTC policy.
 *
 * SECURITY: `IdentityProfile` intentionally has no password field. Proxy passwords
 * are session-scoped secrets and live only in `browser.storage.session` (see
 * `src/background/credentials.ts`). Never add credentials to this model, to the
 * persisted state below, or to anything derived from it.
 */
import { DEFAULT_BYPASS_HOSTS, MAX_PROFILES } from "../shared/constants";

export const PROXY_TYPES = ["direct", "http", "https", "socks4", "socks5"] as const;
export type ProxyType = (typeof PROXY_TYPES)[number];

export const WEBRTC_POLICIES = [
  "default",
  "default_public_interface_only",
  "disable_non_proxied_udp",
  "proxy_only",
] as const;
export type WebRTCPolicy = (typeof WEBRTC_POLICIES)[number];

export const IDENTITY_MODES = ["auto", "manual"] as const;
export type IdentityMode = (typeof IDENTITY_MODES)[number];

export interface ProxyConfig {
  type: ProxyType;
  host?: string;
  port?: number;
  username?: string;
  proxyDNS: boolean;
  bypassHosts: string[];
}

export interface IdentityConfig {
  mode: IdentityMode;
  publicIp?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  timezone?: string;
  lastResolvedAt?: number;
}

export interface IdentityProfile {
  id: string;
  name: string;
  proxy: ProxyConfig;
  identity: IdentityConfig;
  webrtcPolicy: WebRTCPolicy;
}

export interface ProfileState {
  schemaVersion: 1;
  activeProfileId: string | null;
  profiles: IdentityProfile[];
}

export const SCHEMA_VERSION = 1;

/** New proxy profiles default to the strictest practical policy. */
export const DEFAULT_PROXY_WEBRTC_POLICY: WebRTCPolicy = "disable_non_proxied_udp";
/** A direct connection has nothing to protect, so the browser default is kept. */
export const DEFAULT_DIRECT_WEBRTC_POLICY: WebRTCPolicy = "default";

export const BUILTIN_DIRECT_PROFILE_ID = "builtin-direct";
export const BUILTIN_DIRECT_NAME = "Direct";

export function isBuiltinDirectProfile(id: string): boolean {
  return id === BUILTIN_DIRECT_PROFILE_ID;
}

export function createBuiltinDirectProfile(): IdentityProfile {
  return {
    id: BUILTIN_DIRECT_PROFILE_ID,
    name: BUILTIN_DIRECT_NAME,
    proxy: {
      type: "direct",
      proxyDNS: false,
      bypassHosts: [...DEFAULT_BYPASS_HOSTS],
    },
    identity: { mode: "auto" },
    webrtcPolicy: DEFAULT_DIRECT_WEBRTC_POLICY,
  };
}

export const EMPTY_PROFILE_STATE: ProfileState = {
  schemaVersion: SCHEMA_VERSION,
  activeProfileId: null,
  profiles: [createBuiltinDirectProfile()],
};

export function ensureBuiltinDirect(state: ProfileState): ProfileState {
  const existingIndex = state.profiles.findIndex(
    (profile) => profile.id === BUILTIN_DIRECT_PROFILE_ID,
  );
  if (existingIndex === 0) {
    return state;
  }
  const profiles = [...state.profiles];
  let directProfile: IdentityProfile;
  if (existingIndex > 0) {
    const spliced = profiles.splice(existingIndex, 1)[0];
    directProfile = spliced ?? createBuiltinDirectProfile();
  } else {
    directProfile = createBuiltinDirectProfile();
  }
  profiles.unshift(directProfile);
  return {
    schemaVersion: SCHEMA_VERSION,
    activeProfileId: state.activeProfileId,
    profiles,
  };
}

export function defaultWebRtcPolicyFor(proxyType: ProxyType): WebRTCPolicy {
  return proxyType === "direct" ? DEFAULT_DIRECT_WEBRTC_POLICY : DEFAULT_PROXY_WEBRTC_POLICY;
}

export function isProxied(proxy: ProxyConfig): boolean {
  return proxy.type !== "direct";
}

export function createProfile(
  id: string,
  name: string,
  proxyType: ProxyType = "direct",
): IdentityProfile {
  return {
    id,
    name,
    proxy: {
      type: proxyType,
      ...(proxyType === "direct" ? {} : { host: "", port: 8080 }),
      proxyDNS: proxyType === "socks5",
      bypassHosts: [...DEFAULT_BYPASS_HOSTS],
    },
    identity: { mode: "auto" },
    webrtcPolicy: defaultWebRtcPolicyFor(proxyType),
  };
}

/** Human-readable one-line proxy summary. Contains no credentials. */
export function describeProxy(proxy: ProxyConfig): string {
  if (proxy.type === "direct") return "Browser routing (does not override Firefox's proxy)";
  const host = proxy.host ?? "?";
  const port = proxy.port === undefined ? "?" : String(proxy.port);
  const auth = proxy.username ? " with authentication" : "";
  return `${proxy.type.toUpperCase()} ${host}:${port}${auth}`;
}

export function canStoreMoreProfiles(state: ProfileState): boolean {
  return state.profiles.length < MAX_PROFILES;
}
