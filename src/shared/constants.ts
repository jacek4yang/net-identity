/** Static values shared by the background script, UI pages and content scripts. */

export const EXTENSION_ID = "net-identity@jacek4yang.github.io";
export const EXTENSION_NAME = "net-identity";

/** Identity profiles and the active profile pointer live here (never passwords). */
export const STORAGE_KEY = "ni.state.v1";

/**
 * Snapshot of the currently activated target. Deliberately stored in
 * `storage.session` because it contains the proxy password for the active profile.
 */
export const ACTIVE_TARGET_KEY = "ni.active-target.v1";

export const CREDENTIAL_KEY_PREFIX = "ni.cred.v1.";

/** Loopback hosts are always bypassed; the GeoIP endpoint deliberately is not. */
export const DEFAULT_BYPASS_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1"];

export const MAX_PROFILES = 50;
export const MAX_PROFILE_NAME_LENGTH = 64;
export const MAX_HOST_LENGTH = 253;
export const MAX_LOCATION_TEXT_LENGTH = 96;
export const MAX_BYPASS_ENTRIES = 100;
export const MAX_BYPASS_ENTRY_LENGTH = 64;
export const MAX_USERNAME_LENGTH = 255;
export const MAX_PASSWORD_LENGTH = 256;
export const MAX_DISTINCT_TABS_TO_PROBE = 32;

/** Coarse accuracy attached to provider-supplied coordinates (metres). */
export const GEOIP_ACCURACY_METERS = 20000;

export const GEOIP_TIMEOUT_MS = 8000;

/**
 * How long the MAIN-world geolocation shim may hold a page request while an
 * identity is unresolved and the page did not set a shorter timeout.
 *
 * This is longer than {@link GEOIP_TIMEOUT_MS} so a lookup that succeeds or fails
 * is committed before the shim gives up. The result is a timeout error, never a
 * call to Firefox's geolocation API.
 */
export const CONTENT_IDENTITY_WAIT_MS = 10_000;

/** Bounded retry schedule for the MAIN-world shim asking the bridge for data. */
export const CONTENT_ANNOUNCE_DELAYS_MS: readonly number[] = [0, 250, 750, 1500];

export const PUBLIC_IDENTITY_NS = "net-identity";

/** `window.postMessage` channel markers. Page-visible by design, never confidential. */
export const BRIDGE_SOURCE = "net-identity/bridge";
export const PAGE_SOURCE = "net-identity/page";

/** Non-enumerable marker preventing double installation of the MAIN-world shim. */
export const PAGE_SHIM_MARKER = "__netIdentityShim";
