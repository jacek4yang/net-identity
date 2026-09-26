/**
 * The page-visible identity contract.
 *
 * MAIN-world scripts are observable by the page, so this module defines the only
 * data that may ever cross into page context and to the page-messaging channel:
 * coordinates, coarse accuracy, an IANA timezone and the activation generation.
 * Proxy configuration, hosts, ports, usernames and passwords are never included.
 */
import { BRIDGE_SOURCE, GEOIP_ACCURACY_METERS, PAGE_SOURCE, PUBLIC_IDENTITY_NS } from "./constants";
import { isFiniteNumber, isIntegerInRange } from "./primitives";
import { fail, isPlainObject, ok, type Result } from "./result";
import { isValidTimeZone } from "./timezone";

export interface PublicIdentity {
  ns: string;
  generation: number;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  timezone?: string;
}

export interface PublicIdentityInput {
  generation: number;
  latitude?: number | undefined;
  longitude?: number | undefined;
  accuracy?: number | undefined;
  timezone?: string | undefined;
}

/**
 * Builds the page-visible payload. Returns `null` when there is nothing to apply,
 * which keeps pages on native behaviour while no identity is active.
 *
 * Invariant: coordinates always ship with a coarse accuracy. GeoIP coordinates are
 * approximate, and a page-visible position without an accuracy would imply GPS
 * precision the extension does not have.
 */
export function createPublicIdentity(input: PublicIdentityInput): PublicIdentity | null {
  const identity: PublicIdentity = { ns: PUBLIC_IDENTITY_NS, generation: input.generation };

  const hasCoordinates =
    isFiniteNumber(input.latitude) &&
    isFiniteNumber(input.longitude) &&
    input.latitude >= -90 &&
    input.latitude <= 90 &&
    input.longitude >= -180 &&
    input.longitude <= 180;

  if (hasCoordinates && input.latitude !== undefined && input.longitude !== undefined) {
    identity.latitude = input.latitude;
    identity.longitude = input.longitude;
    identity.accuracy =
      isFiniteNumber(input.accuracy) && input.accuracy > 0 ? input.accuracy : GEOIP_ACCURACY_METERS;
  }

  if (isValidTimeZone(input.timezone)) identity.timezone = input.timezone;

  return hasIdentityContent(identity) ? identity : null;
}

/** True when the payload carries something a page shim can actually apply. */
export function hasIdentityContent(identity: PublicIdentity): boolean {
  return identity.latitude !== undefined || identity.timezone !== undefined;
}

export function parsePublicIdentity(value: unknown): Result<PublicIdentity> {
  if (!isPlainObject(value)) return fail("identity payload must be an object");
  if (value.ns !== PUBLIC_IDENTITY_NS) return fail("identity payload has an unexpected namespace");
  if (!isIntegerInRange(value.generation, 0, Number.MAX_SAFE_INTEGER)) {
    return fail("identity payload generation must be a non-negative integer");
  }

  const identity: PublicIdentity = { ns: PUBLIC_IDENTITY_NS, generation: value.generation };

  const hasLatitude = value.latitude !== undefined;
  const hasLongitude = value.longitude !== undefined;
  if (hasLatitude !== hasLongitude)
    return fail("identity payload must not contain a partial position");
  if (hasLatitude && hasLongitude) {
    if (!isFiniteNumber(value.latitude) || value.latitude < -90 || value.latitude > 90) {
      return fail("identity payload latitude is out of range");
    }
    if (!isFiniteNumber(value.longitude) || value.longitude < -180 || value.longitude > 180) {
      return fail("identity payload longitude is out of range");
    }
    identity.latitude = value.latitude;
    identity.longitude = value.longitude;
    if (value.accuracy !== undefined) {
      if (!isFiniteNumber(value.accuracy) || value.accuracy <= 0) {
        return fail("identity payload accuracy must be a positive number of metres");
      }
      identity.accuracy = value.accuracy;
    } else {
      return fail("identity payload coordinates must include a coarse accuracy");
    }
  }

  if (value.timezone !== undefined) {
    if (!isValidTimeZone(value.timezone))
      return fail("identity payload timezone is not a valid IANA zone");
    identity.timezone = value.timezone;
  }

  return ok(identity);
}

/** Background/content-script handshake and update envelope. */
export interface IdentityEnvelope {
  source: typeof BRIDGE_SOURCE;
  type: "identity";
  payload: PublicIdentity | null;
  /** True while a resolution is in flight, so page shims can briefly wait. */
  pending: boolean;
}

export function createIdentityEnvelope(
  payload: PublicIdentity | null,
  pending: boolean,
): IdentityEnvelope {
  return { source: BRIDGE_SOURCE, type: "identity", payload, pending };
}

export function parseIdentityEnvelope(
  value: unknown,
  expectedSource: string,
): Result<IdentityEnvelope> {
  if (!isPlainObject(value)) return fail("identity envelope must be an object");
  if (value.source !== expectedSource) return fail("identity envelope has an unexpected source");
  if (value.type !== "identity") return fail("identity envelope has an unexpected type");
  if (typeof value.pending !== "boolean")
    return fail("identity envelope must declare a pending flag");
  if (value.payload === null || value.payload === undefined) {
    return ok({ source: BRIDGE_SOURCE, type: "identity", payload: null, pending: value.pending });
  }
  const parsed = parsePublicIdentity(value.payload);
  if (!parsed.ok) return fail(...parsed.errors);
  return ok({
    source: BRIDGE_SOURCE,
    type: "identity",
    payload: parsed.value,
    pending: value.pending,
  });
}

/** MAIN world → isolated world: "I am installed, send me the current identity". */
export interface PageAnnounceMessage {
  source: typeof PAGE_SOURCE;
  type: "hello";
}

export function createPageAnnounce(): PageAnnounceMessage {
  return { source: PAGE_SOURCE, type: "hello" };
}

export function parsePageAnnounce(value: unknown): Result<PageAnnounceMessage> {
  if (!isPlainObject(value)) return fail("page message must be an object");
  if (value.source !== PAGE_SOURCE) return fail("page message has an unexpected source");
  if (value.type !== "hello") return fail("page message has an unexpected type");
  return ok({ source: PAGE_SOURCE, type: "hello" });
}

/**
 * MAIN world → isolated world diagnostic report. Untrusted by definition, used
 * only to detect stale injections, never to carry identity data.
 */
export interface PageAppliedReport {
  source: typeof PAGE_SOURCE;
  type: "applied";
  generation: number;
  timezone: string | null;
  hasGeolocationOverride: boolean;
}

export function createPageAppliedReport(input: {
  generation: number;
  timezone: string | null;
  hasGeolocationOverride: boolean;
}): PageAppliedReport {
  return {
    source: PAGE_SOURCE,
    type: "applied",
    generation: input.generation,
    timezone: input.timezone,
    hasGeolocationOverride: input.hasGeolocationOverride,
  };
}

export function parsePageAppliedReport(value: unknown): Result<PageAppliedReport> {
  if (!isPlainObject(value)) return fail("page report must be an object");
  if (value.source !== PAGE_SOURCE) return fail("page report has an unexpected source");
  if (value.type !== "applied") return fail("page report has an unexpected type");
  if (!isIntegerInRange(value.generation, 0, Number.MAX_SAFE_INTEGER)) {
    return fail("page report generation must be a non-negative integer");
  }
  if (value.timezone !== null && !isValidTimeZone(value.timezone)) {
    return fail("page report timezone is not a valid IANA zone");
  }
  if (typeof value.hasGeolocationOverride !== "boolean") {
    return fail("page report must declare whether the geolocation shim is active");
  }
  return ok({
    source: PAGE_SOURCE,
    type: "applied",
    generation: value.generation,
    timezone: value.timezone,
    hasGeolocationOverride: value.hasGeolocationOverride,
  });
}

/** Serialised form sent to the page. Kept as a helper so tests can assert hygiene. */
export function serializeForPage(identity: PublicIdentity | null, pending: boolean): string {
  return JSON.stringify(createIdentityEnvelope(identity, pending));
}

export const PAGE_CHANNEL_SOURCES = { bridge: BRIDGE_SOURCE, page: PAGE_SOURCE } as const;
