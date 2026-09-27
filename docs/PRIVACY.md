# Privacy

net-identity does not include telemetry, analytics, or remotely loaded program code.

## What is stored on this computer

| Data                                                                                      | Where                                       | How long                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| Profiles (name, proxy host, username, location, timezone, WebRTC choice)                  | Firefox extension storage (`storage.local`) | Until you delete the profile or the extension |
| Proxy password                                                                            | Firefox session storage                     | Until Firefox exits                           |
| Active routing snapshot, including the password needed after the background page restarts | Firefox session storage                     | Until Firefox exits                           |

A password is not written into the saved profile. Migration removes secret keys from
supported documents that can be migrated safely. Newer or unsafe documents are left
unchanged and held inactive, rather than silently dropping a profile or its proxy.

## What leaves this computer

**Location lookup.** Activating or refreshing a profile can ask `https://ipwho.is/` where the current connection appears to come from. The request sends no cookies, no referrer, and no proxy password. A proxied profile shows that service the proxy's public address. Browser routing shows it your own public address, and only after you allow that collection in Firefox. Installing the extension does not create a profile, so a fresh install makes no such request. Coordinates from this lookup are approximate (about 20 km) and are not presented as GPS.

**Location picker.** The map uses a bundled local coordinate grid. No tile provider is enabled and no map requests leave the options page. Typed coordinates, panning, zoom, selection and marker drag work offline. Neither a Referer override nor a spoofed web origin is used.

**Proxy traffic.** Traffic you choose to send through a proxy goes to that proxy. The extension does not add its own analytics to that traffic.

## What pages can see

Pages receive the location and timezone of the active profile through compatibility shims. Those shims are visible to a page that inspects them. They are not a claim that the browser is anonymous or undetectable. A frame Firefox will not inject into can still see the computer's timezone and location.

## Your choices

- Do not activate a profile, and the extension does not contact the location service.
- Use a proxy profile when the location lookup should see the proxy's address.
- Use Custom identity policies for manual coordinates, a timezone override, unavailable geolocation, or disabled GeoIP lookup. Disabled GeoIP makes no provider request.
- Direct switches routing immediately even without optional consent. It keeps native geolocation blocked until Off; identity is unavailable until a permitted lookup succeeds.
- Save stores edits; Apply activates the saved configuration and leaves unsaved form edits alone. An event-page restart preserves the applied revision and credentials, including when a newer revision was saved. A blank password keeps existing session credentials, and Clear credentials removes the saved credentials (Apply also removes them from runtime).
- Deactivate the profile to stop the shims and release the WebRTC setting.

These notes describe version 1.1.0. The immutable v1.0.0 AMO submission retains the privacy behavior documented in its tagged source archive. Version 1.1.0 keeps the coordinate picker entirely local, exposes Direct virtually, and separates saved configuration from applied runtime.
