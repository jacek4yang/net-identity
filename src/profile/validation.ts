/**
 * Profile validation.
 *
 * Every value that crosses a boundary (storage, UI messages, session snapshots)
 * passes through these parsers. Parsing is *constructive*: a fresh object is built
 * from validated fields, so unknown or unexpected keys are dropped rather than
 * copied. That is what guarantees a password can never be persisted by accident.
 */
import {
  DEFAULT_BYPASS_HOSTS,
  MAX_BYPASS_ENTRIES,
  MAX_LOCATION_TEXT_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_PROFILES,
  MAX_USERNAME_LENGTH,
} from "../shared/constants";
import {
  isFiniteNumber,
  isIpAddress,
  isNonEmptyString,
  isPlainObjectOrNull,
  isValidHost,
  isValidPort,
  normalizeHost,
  normalizeProfileName,
  parseBypassHosts,
  parseIdentityMode,
  parseProxyType,
  parseWebRtcPolicy,
  trimToLength,
} from "../shared/primitives";
import { fail, isPlainObject, ok, type Result } from "../shared/result";
import { isValidTimeZone } from "../shared/timezone";
import {
  SCHEMA_VERSION,
  isBuiltinDirectProfile,
  type AppliedSelection,
  type IdentityConfig,
  type IdentityProfile,
  type ProfileState,
} from "./schema";

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/i;
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

export function isValidProfileId(value: unknown): value is string {
  return typeof value === "string" && PROFILE_ID_PATTERN.test(value);
}

export interface ProxyCredentials {
  username: string;
  password: string;
}

function parseOptionalText(
  value: unknown,
  maxLength: number,
  label: string,
): Result<string | undefined> {
  if (value === undefined || value === null || value === "") return ok(undefined);
  if (!isNonEmptyString(value, maxLength * 2)) return fail(`${label} must be text`);
  const text = trimToLength(value, maxLength);
  return text === "" ? ok(undefined) : ok(text);
}

function parseOptionalDimension(
  value: unknown,
  min: number,
  max: number,
  label: string,
): Result<number | undefined> {
  if (value === undefined || value === null) return ok(undefined);
  if (!isFiniteNumber(value) || value < min || value > max) {
    return fail(`${label} must be a number between ${min} and ${max}`);
  }
  return ok(value);
}

function parseAccuracy(value: unknown): Result<number | undefined> {
  if (value === undefined || value === null) return ok(undefined);
  if (!isFiniteNumber(value) || value <= 0 || value > 1_000_000) {
    return fail("accuracy must be a positive number of metres (max 1,000,000)");
  }
  return ok(value);
}

function parseCountryCode(value: unknown): Result<string | undefined> {
  if (value === undefined || value === null || value === "") return ok(undefined);
  if (typeof value !== "string") return fail("country code must be text");
  const code = value.trim().toUpperCase();
  if (!COUNTRY_CODE_PATTERN.test(code))
    return fail("country code must be two letters (for example US)");
  return ok(code);
}

function parsePublicIp(value: unknown): Result<string | undefined> {
  if (value === undefined || value === null || value === "") return ok(undefined);
  if (typeof value !== "string" || !isIpAddress(value)) {
    return fail("public IP must be a valid IPv4 or IPv6 address");
  }
  return ok(value.trim());
}

function parseTimezone(value: unknown): Result<string | undefined> {
  if (value === undefined || value === null || value === "") return ok(undefined);
  if (!isValidTimeZone(value)) {
    return fail(
      "timezone must be a valid IANA timezone identifier (for example America/Los_Angeles)",
    );
  }
  return ok(value.trim());
}

function parseTimestamp(value: unknown): Result<number | undefined> {
  if (value === undefined || value === null) return ok(undefined);
  if (!isFiniteNumber(value) || value < 0 || !Number.isInteger(value)) {
    return fail("lastResolvedAt must be a millisecond timestamp");
  }
  return ok(value);
}

export function parseProxyConfig(input: unknown): Result<IdentityProfile["proxy"]> {
  if (!isPlainObject(input)) return fail("proxy configuration is required");
  const errors: string[] = [];

  let type: IdentityProfile["proxy"]["type"] = "direct";
  const typeResult = parseProxyType(input.type);
  if (typeResult.ok) type = typeResult.value;
  else errors.push(...typeResult.errors);

  const isDirect = type === "direct";

  let host: string | undefined;
  if (isDirect) {
    host = undefined;
  } else if (input.host === undefined || input.host === null || input.host === "") {
    errors.push(`${type} proxies require a host`);
  } else if (typeof input.host !== "string" || !isValidHost(input.host)) {
    errors.push("proxy host must be a hostname, IPv4 address or IPv6 address");
  } else {
    host = normalizeHost(input.host);
  }

  let port: number | undefined;
  if (isDirect) {
    port = undefined;
  } else if (input.port === undefined || input.port === null || input.port === "") {
    errors.push(`${type} proxies require a port`);
  } else if (!isValidPort(input.port)) {
    errors.push("proxy port must be an integer between 1 and 65535");
  } else {
    port = input.port;
  }

  // Accept legacy usernames only as an authentication marker. Never return the value.
  if (
    input.username !== undefined &&
    input.username !== null &&
    input.username !== "" &&
    !isNonEmptyString(input.username, MAX_USERNAME_LENGTH)
  ) {
    errors.push("proxy username is too long or empty");
  }
  if (
    input.authenticationRequired !== undefined &&
    typeof input.authenticationRequired !== "boolean"
  ) {
    errors.push("proxy authentication requirement must be boolean");
  }
  const authenticationRequired =
    !isDirect &&
    (input.authenticationRequired === true ||
      (typeof input.username === "string" && input.username.trim() !== ""));

  const proxyDNS = input.proxyDNS === undefined ? type === "socks5" : input.proxyDNS === true;

  const bypassResult = parseBypassHosts(
    input.bypassHosts === undefined ? [...DEFAULT_BYPASS_HOSTS] : input.bypassHosts,
    MAX_BYPASS_ENTRIES,
  );
  const bypassHosts = bypassResult.ok ? bypassResult.value : [];
  if (!bypassResult.ok) errors.push(...bypassResult.errors);

  if (errors.length > 0) return fail(...errors);
  return ok({
    type,
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(authenticationRequired ? { authenticationRequired: true } : {}),
    proxyDNS,
    bypassHosts,
  });
}

export function parseIdentityConfig(input: unknown): Result<IdentityConfig> {
  if (!isPlainObject(input)) return fail("identity configuration is required");
  const errors: string[] = [];

  let mode: IdentityConfig["mode"] = "auto";
  const modeResult = parseIdentityMode(input.mode);
  if (modeResult.ok) mode = modeResult.value;
  else errors.push(...modeResult.errors);

  const publicIpResult = parsePublicIp(input.publicIp);
  const countryResult = parseCountryCode(input.countryCode);
  const regionResult = parseOptionalText(input.region, MAX_LOCATION_TEXT_LENGTH, "region");
  const cityResult = parseOptionalText(input.city, MAX_LOCATION_TEXT_LENGTH, "city");
  const latitudeResult = parseOptionalDimension(input.latitude, -90, 90, "latitude");
  const longitudeResult = parseOptionalDimension(input.longitude, -180, 180, "longitude");
  const accuracyResult = parseAccuracy(input.accuracy);
  const timezoneResult = parseTimezone(input.timezone);
  const timestampResult = parseTimestamp(input.lastResolvedAt);

  for (const result of [
    publicIpResult,
    countryResult,
    regionResult,
    cityResult,
    latitudeResult,
    longitudeResult,
    accuracyResult,
    timezoneResult,
    timestampResult,
  ]) {
    if (!result.ok) errors.push(...result.errors);
  }

  if (
    (latitudeResult.ok && latitudeResult.value !== undefined) !==
    (longitudeResult.ok && longitudeResult.value !== undefined)
  ) {
    errors.push("latitude and longitude must be provided together");
  }

  const geoIpPolicy = input.geoIpPolicy ?? "automatic";
  const geolocationPolicy = input.geolocationPolicy ?? (mode === "manual" ? "manual" : "follow");
  const timezonePolicy = input.timezonePolicy ?? (mode === "manual" ? "manual" : "follow");
  if (geoIpPolicy !== "automatic" && geoIpPolicy !== "disabled")
    return fail("invalid GeoIP policy");
  if (
    geolocationPolicy !== "follow" &&
    geolocationPolicy !== "manual" &&
    geolocationPolicy !== "disabled"
  )
    return fail("invalid geolocation policy");
  if (timezonePolicy !== "follow" && timezonePolicy !== "manual")
    return fail("invalid timezone policy");
  if (input.providerId !== undefined && input.providerId !== "ipwho.is")
    return fail("unsupported GeoIP provider");

  if (geolocationPolicy === "manual") {
    if (!latitudeResult.ok || latitudeResult.value === undefined)
      errors.push("manual mode requires a latitude");
    if (!longitudeResult.ok || longitudeResult.value === undefined)
      errors.push("manual mode requires a longitude");
    if (!accuracyResult.ok || accuracyResult.value === undefined)
      errors.push("manual mode requires an accuracy in metres");
  }
  if (timezonePolicy === "manual" && (!timezoneResult.ok || timezoneResult.value === undefined))
    errors.push("manual mode requires an IANA timezone");

  if (errors.length > 0) return fail(...errors);

  const identity: IdentityConfig = {
    mode,
    geoIpPolicy,
    providerId: "ipwho.is",
    geolocationPolicy,
    timezonePolicy,
  };
  if (publicIpResult.ok && publicIpResult.value !== undefined)
    identity.publicIp = publicIpResult.value;
  if (countryResult.ok && countryResult.value !== undefined)
    identity.countryCode = countryResult.value;
  if (regionResult.ok && regionResult.value !== undefined) identity.region = regionResult.value;
  if (cityResult.ok && cityResult.value !== undefined) identity.city = cityResult.value;
  if (latitudeResult.ok && latitudeResult.value !== undefined)
    identity.latitude = latitudeResult.value;
  if (longitudeResult.ok && longitudeResult.value !== undefined)
    identity.longitude = longitudeResult.value;
  if (accuracyResult.ok && accuracyResult.value !== undefined)
    identity.accuracy = accuracyResult.value;
  if (timezoneResult.ok && timezoneResult.value !== undefined)
    identity.timezone = timezoneResult.value;
  if (timestampResult.ok && timestampResult.value !== undefined)
    identity.lastResolvedAt = timestampResult.value;
  return ok(identity);
}

export function parseProfile(input: unknown): Result<IdentityProfile> {
  if (!isPlainObject(input)) return fail("profile must be an object");
  const errors: string[] = [];

  let id = "";
  if (isValidProfileId(input.id)) id = input.id;
  else errors.push("profile id is missing or malformed");

  const name = normalizeProfileName(input.name);
  if (name === null) errors.push("profile name is required (maximum 64 characters)");

  const proxyResult = parseProxyConfig(input.proxy);
  if (!proxyResult.ok) errors.push(...proxyResult.errors);

  const identityResult = parseIdentityConfig(input.identity);
  if (!identityResult.ok) errors.push(...identityResult.errors);

  const revision = input.revision ?? 1;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)
    return fail("invalid profile revision");
  const webrtcMode = input.webrtcMode ?? "manual";
  if (webrtcMode !== "manual" && webrtcMode !== "automatic") return fail("invalid WebRTC mode");
  const policyResult = parseWebRtcPolicy(input.webrtcPolicy);
  if (!policyResult.ok) errors.push(...policyResult.errors);

  if (
    errors.length > 0 ||
    name === null ||
    !proxyResult.ok ||
    !identityResult.ok ||
    !policyResult.ok
  ) {
    return fail(...(errors.length > 0 ? errors : ["profile is invalid"]));
  }

  return ok({
    id,
    name,
    proxy: proxyResult.value,
    identity: identityResult.value,
    webrtcPolicy: policyResult.value,
    webrtcMode,
    revision,
  });
}

/**
 * Parses a document that is already the current schema. Invalid profiles are
 * skipped. Stored data goes through `migrateStoredProfileState` instead, which
 * refuses to drop a profile or replace a newer schema.
 */
export function parseProfileState(input: unknown): Result<ProfileState> {
  if (!isPlainObject(input)) return fail("stored profile state is not an object");
  if (input.schemaVersion !== SCHEMA_VERSION) {
    return fail(`unsupported stored schema version: ${String(input.schemaVersion)}`);
  }

  const rawProfiles = Array.isArray(input.profiles) ? input.profiles : [];
  const profiles: IdentityProfile[] = [];
  const seen = new Set<string>();
  for (const rawProfile of rawProfiles.slice(0, MAX_PROFILES)) {
    const parsed = parseProfile(rawProfile);
    if (!parsed.ok) continue;
    if (seen.has(parsed.value.id)) continue;
    seen.add(parsed.value.id);
    profiles.push(parsed.value);
  }

  const rawActive = input.activeProfileId;
  const activeProfileId = typeof rawActive === "string" && seen.has(rawActive) ? rawActive : null;
  const selection = parseAppliedSelection(input.appliedSelection, activeProfileId);
  if (!selection.ok) return selection;
  return ok({
    schemaVersion: SCHEMA_VERSION,
    activeProfileId,
    appliedSelection: selection.value,
    profiles,
  });
}

export function parseAppliedSelection(
  value: unknown,
  activeProfileId: string | null,
): Result<AppliedSelection | null> {
  if (activeProfileId === null)
    return value === null ? ok(null) : fail("Off cannot have an applied route");
  if (!isPlainObject(value)) return fail("applied route is invalid");
  if (isBuiltinDirectProfile(activeProfileId))
    return value.kind === "builtin-direct"
      ? ok({ kind: "builtin-direct" })
      : fail("reserved Direct route mismatch");
  if (value.kind === "unresolved" && value.profileId === activeProfileId)
    return ok({ kind: "unresolved", profileId: activeProfileId });
  if (value.kind !== "profile") return fail("applied route is invalid");
  const parsed = parseProfile(value.profile);
  if (!parsed.ok || parsed.value.id !== activeProfileId) return fail("applied profile mismatch");
  return ok({ kind: "profile", profile: parsed.value });
}

export function parseCredentials(input: unknown): Result<ProxyCredentials> {
  if (!isPlainObject(input)) return fail("credentials must be an object");
  const username = input.username;
  const password = input.password;
  if (typeof username !== "string" && typeof password !== "string") {
    return fail("credentials must contain a username or a password");
  }
  if (username !== undefined && typeof username !== "string") return fail("username must be text");
  if (password !== undefined && typeof password !== "string") return fail("password must be text");
  const parsedUsername = typeof username === "string" ? username : "";
  const parsedPassword = typeof password === "string" ? password : "";
  if (parsedUsername.length > MAX_USERNAME_LENGTH) return fail("username is too long");
  if (parsedPassword.length > MAX_PASSWORD_LENGTH) return fail("password is too long");
  if (parsedUsername === "" && parsedPassword === "") return fail("credentials must not be empty");
  return ok({ username: parsedUsername, password: parsedPassword });
}

export function isPlainObjectLike(value: unknown): value is Record<string, unknown> {
  return isPlainObjectOrNull(value) === true;
}
