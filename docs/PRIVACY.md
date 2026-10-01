# Privacy

net-identity does not include telemetry, analytics, or remotely loaded program code.

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

**Location picker.** The map uses a bundled local coordinate grid. No tile provider is enabled and no map requests leave the options page. Typed coordinates, panning, zoom, selection and marker drag work offline. Neither a Referer override nor a spoofed web origin is used.

**Proxy traffic.** Traffic you choose to send through a proxy goes to that proxy. The extension does not add its own analytics to that traffic.
If a selected proxy fails, ordinary external traffic fails rather than switching to
Firefox's direct or system route. The selected profile stays selected and can recover
without a route switch. After a full Firefox exit, session-only usernames and passwords are lost;
traffic remains restricted to the selected proxy until credentials are supplied again.

**Proxy transport security.** Session-only storage does not encrypt the connection to a proxy.
SOCKS5 username/password authentication is plaintext on that connection
([RFC 1929](https://www.rfc-editor.org/rfc/rfc1929.html#section-3)); HTTP proxy Basic
authentication likewise needs a protected transport. HTTPS to a destination does not
by itself encrypt the preceding SOCKS authentication. Use only a trusted proxy and
a suitably protected network path. This extension does not add an encrypted tunnel.

## What pages can see

Pages receive the location and timezone of the active profile through compatibility shims. Those shims are visible to a page that inspects them. They are not a claim that the browser is anonymous or undetectable. A frame Firefox will not inject into can still see the computer's timezone and location.

## Your choices

- Do not activate a profile, and the extension does not contact the location service.
- Use a proxy profile when the location lookup should see the proxy's address.
- Use Custom identity policies for manual coordinates, a timezone override, unavailable geolocation, or disabled GeoIP lookup. Disabled GeoIP makes no provider request.
- Direct switches routing immediately even without optional consent. It keeps native geolocation blocked until Off; identity is unavailable until a permitted lookup succeeds.
- Save stores edits; Apply activates the saved configuration and leaves unsaved form edits alone. An event-page restart preserves the applied revision and credentials, including when a newer revision was saved. Leaving both username and password blank keeps existing session credentials; entering either replaces the pair, and Clear credentials removes the saved credentials (Apply also removes them from runtime).
- Deactivate the profile to stop the shims and release the WebRTC setting.

These notes describe the 1.1.3 schema-4 release candidate. Version 1.1.3 was verified absent on AMO on 2026-10-01 before selection; this document does not imply submission, signing or publication. Earlier AMO submissions retain the privacy behavior documented in their immutable tagged source archives. The coordinate picker remains entirely local, Direct is virtual, and the committed applied route is stored separately from saved edits without usernames or passwords.

## Passive health observations

The background temporarily correlates at most 512 request IDs with the selected SOCKS
endpoint, route generation and destination hostname. It keeps no URL path/query,
headers or event-provided credentials. Samples expire after 30 seconds, failure evidence
uses a five-second window, and everything is in memory, not durable storage or telemetry.
These observations can indicate suspected trouble but cannot identify its transport cause.
No diagnostic probe or automatic HTTP retry is sent. Credentials you supply are transmitted
only to your selected proxy for authentication, never to the GeoIP provider or page scripts.

## Firefox consent

Required `locationInfo` describes approximate egress location lookup. Required
`authenticationInfo` describes the existing credentials sent to the proxy you choose.
Optional `personallyIdentifyingInfo` still gates a direct lookup that exposes your own
public IP. The authentication declaration corrects disclosure, not behavior: no extra
recipient, telemetry or browser API permission is introduced. Firefox may show changed
required-data consent on installation or update. These built-in controls require desktop
Firefox 140 or later. [Mozilla's data taxonomy](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
explains the categories.
