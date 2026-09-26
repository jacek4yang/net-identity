/**
 * GeoIP provider abstraction.
 *
 * The rest of the extension depends only on this interface, never on a specific
 * vendor. A provider observes the *actual browser egress* because the request is
 * made from the background script and therefore travels through the active proxy
 * (the GeoIP endpoint is never added to the bypass list).
 *
 * Provider responses are untrusted input: always parsed with
 * {@link GeoIpProvider.resolve} which validates every field.
 */
export interface GeoIpResult {
  ip: string;
  countryCode?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
}

export type GeoIpErrorCode = "aborted" | "timeout" | "network" | "http" | "malformed";

export class GeoIpError extends Error {
  readonly code: GeoIpErrorCode;
  readonly status: number | undefined;

  constructor(code: GeoIpErrorCode, message: string, status?: number) {
    super(message);
    this.name = "GeoIpError";
    this.code = code;
    this.status = status;
  }
}

export interface GeoIpProvider {
  /** Stable identifier, used in diagnostics and never containing secrets. */
  readonly id: string;
  /** Human-readable provider name for the UI. */
  readonly label: string;
  /** Endpoint that receives a request whenever an identity is resolved. */
  readonly endpoint: string;
  resolve(signal?: AbortSignal): Promise<GeoIpResult>;
}

export function isGeoIpError(value: unknown): value is GeoIpError {
  return value instanceof GeoIpError;
}

/** Maps a provider failure to a precise, non-alarming UI message. */
export function describeGeoIpFailure(error: unknown): string {
  if (isGeoIpError(error)) {
    switch (error.code) {
      case "timeout":
        return "GeoIP lookup timed out. The proxy may be unreachable.";
      case "aborted":
        return "GeoIP lookup was cancelled.";
      case "http":
        return `GeoIP provider returned HTTP ${error.status ?? "error"}.`;
      case "network":
        return "GeoIP provider could not be reached through the active proxy.";
      case "malformed":
        return "GeoIP provider returned an unusable response.";
    }
  }
  return "GeoIP lookup failed.";
}
