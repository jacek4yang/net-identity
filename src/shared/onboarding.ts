/**
 * Plain-language copy for the popup and options page.
 *
 * The strings are the product explanation. Tests pin them so a later edit
 * cannot drop the privacy and failure guidance.
 */

export interface GuideSection {
  title: string;
  body: string;
}

export const GUIDE: readonly GuideSection[] = [
  {
    title: "What a profile does",
    body: "A profile applies one network identity together: how Firefox connects, the location pages see, the timezone pages see, and WebRTC address handling. Choose Direct or a proxy row to activate it. Off releases identity and WebRTC control. Save stores edits; Save & Activate applies them.",
  },
  {
    title: "Browser routing",
    body: "Browser routing uses Firefox's own connection. It does not turn off a proxy you set in Firefox or on this computer. Choose an HTTP, HTTPS, or SOCKS proxy when this profile should send traffic through a specific server.",
  },
  {
    title: "Automatic or manual location",
    body: "Automatic asks where the connection appears to come from. That place is approximate, about 20 km, not a GPS fix. A proxied profile shows the proxy's address. Browser routing shows your own public address and waits until you allow that. Manual lets you type coordinates or pick them on the map. The map still works when its pictures cannot load.",
  },
  {
    title: "WebRTC",
    body: "The WebRTC policy limits which network addresses a page can learn. If another extension or a Firefox policy already controls that setting, this extension leaves it alone and says so.",
  },
  {
    title: "When something fails",
    body: "An unreachable proxy or a missing password stops the new identity and keeps the previous page location, instead of revealing your real one. Refresh Identity tries the lookup again. A frame the browser will not inject into can still see the computer's timezone; that limit is reported, not hidden.",
  },
];

export function showFirstRun(profileCount: number): boolean {
  return profileCount === 0;
}

export function describeRouting(
  configured: boolean,
  type: string,
  host?: string,
  port?: number,
): string {
  if (!configured || type === "direct") {
    return "Browser routing. This does not override a proxy set in Firefox.";
  }
  return `${type.toUpperCase()} ${host ?? "?"}:${String(port ?? "?")}`;
}

/** Adds a next step to a background error without hiding the original reason. */
export function explainRuntimeError(code: string | undefined, message: string): string {
  switch (code) {
    case "consent_required":
      return `${message} Routing is already active. Press Refresh to allow the personal-data lookup, or keep using the route without GeoIP.`;
    case "provider_error":
      return `${message} Check that the proxy can reach the internet, then press Refresh Identity. Native geolocation remains blocked while controlled.`;
    case "proxy_error":
      return `${message} Check the proxy host, port, and password. The password is kept only until Firefox exits.`;
    case "schema_unsupported":
      return `${message} Do not delete the extension data; a newer version is required to read it.`;
    default:
      return message;
  }
}
