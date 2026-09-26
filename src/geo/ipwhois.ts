/**
 * Default GeoIP provider: ipwho.is, a no-key HTTPS endpoint.
 *
 * Privacy note: enabling an automatic identity performs a request to this
 * third-party endpoint from the active proxy egress. That request exposes the
 * proxy's public IP address (not this browser's real one) to the provider. No
 * credentials, cookies or referrers are sent, and the response is never cached.
 *
 * To add a provider: implement {@link GeoIpProvider}, validate every field with a
 * parser like the one below, and register it in `createDefaultGeoIpProvider`.
 */
import { GEOIP_TIMEOUT_MS, MAX_LOCATION_TEXT_LENGTH } from "../shared/constants";
import { isIpAddress, trimToLength } from "../shared/primitives";
import { fail, isPlainObject, ok, describeError, type Result } from "../shared/result";
import { isValidTimeZone } from "../shared/timezone";
import { GeoIpError, type GeoIpProvider, type GeoIpResult } from "./provider";

export const IPWHOIS_ENDPOINT =
  "https://ipwho.is/?fields=success,message,ip,country_code,region,city,latitude,longitude,timezone";

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

function sanitizeText(value: string): string {
  // Strip control characters and collapse whitespace; providers are untrusted input.
  // eslint-disable-next-line no-control-regex -- control characters must be removed
  const withoutControlCharacters = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  return trimToLength(
    withoutControlCharacters.replace(/\s+/g, " ").trim(),
    MAX_LOCATION_TEXT_LENGTH,
  );
}

function parseOptionalCoordinate(
  value: unknown,
  min: number,
  max: number,
): number | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    return "invalid";
  return value;
}

/**
 * Validates an ipwho.is payload.
 *
 * `ip` and `success` are required. Optional fields are validated individually and
 * discarded when they are missing or malformed, so a provider that drops a field
 * degrades to a partial identity instead of breaking identity resolution.
 */
export function parseIpWhoIsResponse(input: unknown): Result<GeoIpResult> {
  if (!isPlainObject(input)) return fail("GeoIP response was not a JSON object");
  if (input.success === false) {
    const message =
      typeof input.message === "string" ? sanitizeText(input.message) : "provider reported failure";
    return fail(`GeoIP provider error: ${message}`);
  }
  if (input.success !== true) return fail("GeoIP response is missing the success flag");
  if (typeof input.ip !== "string" || !isIpAddress(input.ip.trim())) {
    return fail("GeoIP response is missing a valid IP address");
  }

  const result: GeoIpResult = { ip: input.ip.trim() };

  if (typeof input.country_code === "string") {
    const code = input.country_code.trim().toUpperCase();
    if (COUNTRY_CODE_PATTERN.test(code)) result.countryCode = code;
  }

  if (typeof input.region === "string") {
    const region = sanitizeText(input.region);
    if (region !== "") result.region = region;
  }

  if (typeof input.city === "string") {
    const city = sanitizeText(input.city);
    if (city !== "") result.city = city;
  }

  const latitude = parseOptionalCoordinate(input.latitude, -90, 90);
  const longitude = parseOptionalCoordinate(input.longitude, -180, 180);
  // Coordinates are all-or-nothing: a half-populated position is worse than none.
  if (typeof latitude === "number" && typeof longitude === "number") {
    result.latitude = latitude;
    result.longitude = longitude;
  }

  const timezoneField = input.timezone;
  const timezoneCandidate = isPlainObject(timezoneField) ? timezoneField.id : timezoneField;
  if (isValidTimeZone(timezoneCandidate)) result.timezone = timezoneCandidate.trim();

  return ok(result);
}

export interface IpWhoIsProviderOptions {
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  endpoint?: string;
}

/**
 * The slice of `fetch` this provider uses.
 *
 * Narrower than the DOM signature purely so tests can pass a trivial stub; the real
 * `fetch` is assignable to it.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function createIpWhoIsProvider(options: IpWhoIsProviderOptions = {}): GeoIpProvider {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? GEOIP_TIMEOUT_MS;
  const endpoint = options.endpoint ?? IPWHOIS_ENDPOINT;

  return {
    id: "ipwho.is",
    label: "ipwho.is",
    endpoint,

    async resolve(signal?: AbortSignal): Promise<GeoIpResult> {
      if (signal?.aborted) throw new GeoIpError("aborted", "GeoIP lookup was cancelled.");
      if (typeof fetchImpl !== "function") {
        throw new GeoIpError("network", "This Firefox build does not expose fetch to extensions.");
      }

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const forwardAbort = () => controller.abort();
      signal?.addEventListener("abort", forwardAbort, { once: true });

      try {
        let response: Response;
        try {
          response = await fetchImpl(endpoint, {
            method: "GET",
            signal: controller.signal,
            cache: "no-store",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            headers: { accept: "application/json" },
          });
        } catch (error) {
          if (timedOut) {
            throw new GeoIpError("timeout", `GeoIP lookup timed out after ${timeoutMs} ms.`);
          }
          if (signal?.aborted) throw new GeoIpError("aborted", "GeoIP lookup was cancelled.");
          throw new GeoIpError("network", describeError(error, "GeoIP request failed."));
        }

        if (!response.ok) {
          throw new GeoIpError(
            "http",
            `GeoIP provider responded with HTTP ${response.status}.`,
            response.status,
          );
        }

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new GeoIpError("malformed", "GeoIP provider returned invalid JSON.");
        }

        const parsed = parseIpWhoIsResponse(payload);
        if (!parsed.ok) throw new GeoIpError("malformed", parsed.errors.join("; "));
        return parsed.value;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", forwardAbort);
      }
    },
  };
}

/** Single place to change the default provider implementation. */
export function createDefaultGeoIpProvider(): GeoIpProvider {
  return createIpWhoIsProvider();
}
