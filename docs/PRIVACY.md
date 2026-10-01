# Privacy

net-identity does not include telemetry, analytics, or remotely loaded program code.

**Release boundary:** this policy describes approved listed version **1.1.5**, including
its opt-in OpenFreeMap map. The immutable 1.1.3 package and its historical policy describe
the earlier offline-only picker. See [release verification](RELEASING.md#published-115-2026-10-01).

## What is stored on this computer

| Data                                                                                                                      | Where                                       | How long                                      |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| Profiles and non-secret applied route (name, proxy host, authentication-required flag, location, timezone, WebRTC choice) | Firefox extension storage (`storage.local`) | Until you delete the profile or the extension |
| Proxy username and password                                                                                               | Firefox session storage                     | Until Firefox exits                           |
| Active routing snapshot, including the credentials needed after the background page restarts                              | Firefox session storage                     | Until Firefox exits                           |

Neither a username nor a password is written into the saved or applied profile. Schema 4 converts legacy usernames to a non-secret authentication-required flag. Migration removes secret keys from
supported documents that can be migrated safely. Newer or unsafe documents are left
unchanged and held inactive, rather than silently dropping a profile or its proxy.

## What leaves this computer

**Location lookup.** Activating or refreshing a profile can ask `https://ipwho.is/` where the current connection appears to come from. The request sends no cookies, no referrer, and no explicit proxy credentials. A proxied profile shows that service the proxy's public address. Browser routing shows it your own public address, and only after you allow that collection in Firefox. Installing the extension does not create a profile, so a fresh install makes no such request. Coordinates from this lookup are approximate (about 20 km) and are not presented as GPS.

**Location picker.** The picker initially uses a local coordinate grid, with no map
network request. Choosing **Load online map**
explicitly enables a MapLibre basemap for that editor session. Its code, stylesheet
and worker are shipped with the extension; only map data comes from
`https://tiles.openfreemap.org`. Style, tile metadata, vector/raster tiles, sprites
and font glyphs are fetched as needed to display the viewed area. Panning and zooming
can request additional tiles. This is a separate action from GeoIP lookup; disabling
GeoIP does not cancel an explicitly enabled basemap.

OpenFreeMap and its Cloudflare delivery infrastructure can see the network-visible
IP, requested map area (encoded in tile coordinates), and normal HTTP metadata.
The marker coordinates, profile and proxy credentials are not separately uploaded,
but the viewed area is **not private from the map provider**. Requests omit cookies,
origin credentials and referrers, reject redirects, and stay within the approved
provider URL policy. No native device-location API, geocoder, API key or account is
used. The extension does not spoof a Referer or web origin.

An active proxy remains the route for these requests; failure does not trigger Direct.
Provider-host bypass rules refuse online-map loading rather than quietly overriding
the bypass. Under Direct or Off, optional personal-data consent is required before
loading, and Firefox/system proxy settings may still affect the visible IP. Route
changes, permission revocation and closing the editor invalidate map sessions.
Manual coordinate input and the local grid remain usable when the map is disabled,
unavailable, blocked or cannot render with WebGL.

OpenFreeMap's [privacy policy](https://openfreemap.org/privacy/) describes its own
logging: ordinary logs exclude IP addresses, anonymized usage metadata may be kept
indefinitely, and security-incident IP logging may last up to 30 days. Cloudflare may
process requests under its own policy. See the provider's [terms](https://openfreemap.org/tos/).
The extension makes no claim that the provider collects nothing.

**Proxy traffic.** Traffic you choose to send through a proxy goes to that proxy. The extension does not add its own analytics to that traffic.
If a selected proxy fails, ordinary external traffic fails rather than switching to
Firefox's direct or system route. The selected profile stays selected and can recover
without a route switch. After a full Firefox exit, session-only usernames and passwords are lost;
if the applied profile requires authentication, non-bypassed ordinary webpage and
extension-observable GeoIP requests are blocked until you save replacement credentials and Apply them. The request gate prevents those ordinary requests from
trying that endpoint anonymously, even if the proxy would accept it: anonymous access
could produce a different egress identity. Profiles intentionally configured without
authentication and explicit bypasses keep their existing behavior.

**Proxy transport security.** Session-only storage does not encrypt the connection to a proxy.
SOCKS5 username/password authentication is plaintext on that connection
([RFC 1929](https://www.rfc-editor.org/rfc/rfc1929.html#section-3)); HTTP proxy Basic
authentication likewise needs a protected transport. HTTPS to a destination does not
by itself encrypt the preceding SOCKS authentication. Use only a trusted proxy and
a suitably protected network path. This extension does not add an encrypted tunnel.

## What pages can see

Pages receive the location and timezone of the active profile through compatibility shims. Those shims are visible to a page that inspects them. They are not a claim that the browser is anonymous or undetectable. A frame Firefox will not inject into can still see the computer's timezone and location.

## Your choices

- Do not activate a profile, and the extension does not contact the GeoIP service.
- Leave the online map disabled to avoid OpenFreeMap requests. Disable the map or
  close the profile editor to stop its session; this does not change the active identity.
- Use a proxy profile when the location lookup should see the proxy's address.
- Use Custom identity policies for manual coordinates, a timezone override, unavailable geolocation, or disabled GeoIP lookup. Disabled GeoIP makes no GeoIP provider request; separately enabled map requests are independent.
- Direct switches routing immediately even without optional consent. It keeps native geolocation blocked until Off; identity is unavailable until a permitted lookup succeeds.
- Save stores edits; Apply activates the saved configuration and leaves unsaved form edits alone. An event-page restart preserves the applied revision and credentials, including when a newer revision was saved. Leaving both username and password blank keeps existing session credentials; entering either replaces the pair, and Clear credentials removes the saved credentials (Apply also removes them from runtime).
- Deactivate the profile to stop the shims and release the WebRTC setting.

The committed applied route remains separate from editable saved profiles, with no
usernames or passwords in durable profile storage. Historical release behavior is
recorded in immutable tagged source archives and [release history](RELEASING.md).
New map functionality does not alter those historical packages or submissions.

## Passive health observations

The background temporarily correlates at most 512 request IDs with the selected SOCKS
endpoint, route generation and destination hostname. It keeps no URL path/query,
headers or event-provided credentials. Samples expire after 30 seconds, failure evidence
uses a five-second window, and everything is in memory, not durable storage or telemetry.
These observations can indicate suspected trouble but cannot identify its transport cause.
No diagnostic probe or automatic HTTP retry is sent. Credentials you supply are transmitted
only to your selected proxy for authentication, never to the GeoIP provider or page scripts.

## Firefox consent

Required `locationInfo` describes approximate egress location lookup and, for the
online-map feature, the map area requested from OpenFreeMap. Required
`authenticationInfo` describes the existing credentials sent to the proxy you choose.
Optional `personallyIdentifyingInfo` gates direct GeoIP and online-map requests that
can expose your own public IP. OpenFreeMap is an additional recipient only when the
new map is explicitly enabled. The earlier authentication declaration disclosed the
existing proxy-authentication recipient; it did not itself add a recipient or telemetry. Firefox may show changed
required-data consent on installation or update. These built-in controls require desktop
Firefox 140 or later. [Mozilla's data taxonomy](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
explains the categories.

## Protected Firefox requests

Firefox does not let extensions cancel every browser-service request. In Firefox 158,
protected Remote Settings traffic could still reach the same selected proxy anonymously
when the session credential pair was missing. This is not a switch to Direct, but a
proxy that accepts anonymous clients may assign a different egress identity. Ordinary
permitted webpage traffic and observable GeoIP requests remain covered by the missing-
credential gate. For account identity across all browser traffic, configure the proxy
server to reject anonymous access. The extension is not a browser-wide kill switch and
does not change OS firewalls or Firefox security settings.

## HTTP/HTTPS proxy account identity

The proxy server must enforce authentication. Keeping a username/password pair in the
session does not prove every HTTP/HTTPS proxy connection used that account: a server
accepting anonymous CONNECT requests may not issue a 407 challenge. This applies to
ordinary webpage and map traffic too, independently of the Firefox-protected service
limitation. Require the server to reject anonymous access when account identity matters.
This is not a Direct fallback or a guarantee of reauthentication of existing connections.
