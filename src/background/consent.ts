/**
 * GeoIP consent decisions.
 *
 * Firefox 140+ shows required data-collection permissions at install. This
 * extension requires `locationInfo` for that prompt, so a proxied lookup is
 * allowed once the browser reports the data-collection API.
 *
 * A direct profile sends the user's own public IP to the provider. That is
 * optional `personallyIdentifyingInfo` and is not granted by installation.
 * The lookup is refused until that optional grant is present.
 */
import type { ProxyType } from "../profile/schema";

export const PERSONAL_IP_DATA_PERMISSION = "personallyIdentifyingInfo";

export interface DataCollectionSnapshot {
  /** False when Firefox did not return a `data_collection` list. */
  apiAvailable: boolean;
  optionalGranted: readonly string[];
}

export interface GeoIpConsentDecision {
  allowed: boolean;
  code?: "consent_required";
  message?: string;
}

const NO_API =
  "Firefox has not confirmed install-time data-collection consent, so no GeoIP lookup was made.";

const DIRECT_IP =
  "A direct profile would send your own public IP to the GeoIP provider. Allow optional personal-data collection before that lookup.";

export function decideGeoIpConsent(
  proxyType: ProxyType,
  snapshot: DataCollectionSnapshot,
): GeoIpConsentDecision {
  if (!snapshot.apiAvailable) {
    return { allowed: false, code: "consent_required", message: NO_API };
  }
  if (proxyType !== "direct") return { allowed: true };
  if (snapshot.optionalGranted.includes(PERSONAL_IP_DATA_PERMISSION)) return { allowed: true };
  return { allowed: false, code: "consent_required", message: DIRECT_IP };
}
