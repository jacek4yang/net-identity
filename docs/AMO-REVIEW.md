# Notes for addons.mozilla.org review

The extension id is `net-identity@jacek4yang.github.io` and does not change between versions.

## Permissions

- `proxy` and `<all_urls>`: `proxy.onRequest` decides the proxy for `http`, `https`, `ws`, and `wss`. Host permission is required for that listener. Other schemes stay direct.
- `webRequest` and `webRequestBlocking`: HTTP/HTTPS proxy passwords and fail-closed routing. The extension answers a challenge only when Firefox reports a proxy challenge whose host and port both match the active proxy, and only once per request. SOCKS passwords use `ProxyInfo` and are not sent through `onAuthRequired`. During startup, the blocking request listener cancels external requests if a committed proxy route cannot be reconstructed safely.
- `privacy`: read and set `webRTCIPHandlingPolicy`, then `clear()` on deactivation so Firefox restores the previous value. If another extension or policy controls the setting, this extension does not overwrite it.
- `storage`: profiles in `storage.local` (never proxy usernames or passwords) and session-only secrets in `storage.session`.
- Data collection: required `locationInfo` for the egress lookup and `authenticationInfo` for existing credentials sent to the selected proxy. Optional `personallyIdentifyingInfo` before a browser-routing profile may send the user's own public IP. See `docs/PRIVACY.md`.

## Page behaviour

Content scripts run in every frame, including `about:blank`. The MAIN-world script patches `Date` / `Intl` and `navigator.geolocation` for the active profile. Proxy usernames and passwords are not sent to pages. While a profile is activating, failing, or active, the geolocation shim does not call Firefox's implementation.

A sandboxed frame Firefox refuses to inject can still see the computer's timezone and location. That is a platform limit.

## Map

The options map is a bundled local coordinate grid. No external tile provider is enabled,
no images are fetched, and no remote executable code is loaded. Coordinate entry, marker
drag, selection, panning and zoom work offline. See `docs/TILE-POLICY.md` for the decision.

The built-in Direct route exists virtually on fresh install; it does not trigger lookup.
Direct switches without optional consent and withholds GeoIP until permission is granted.
Custom policies can disable GeoIP and make geolocation unavailable without native fallback.
Save persists configuration; Apply changes runtime. Version-1, version-2 and version-3 profiles migrate to schema 4. Legacy usernames become a non-secret authentication-required flag; the value is removed from both saved and applied profiles.
Apply uses the saved revision without saving unsaved form values. Applied configuration
is also recorded without credentials in local storage so a full Firefox restart cannot
activate a newer unapplied Save. Session credentials survive event-page suspension but
are removed on full exit. A selected proxy stays selected, and external traffic fails,
when the proxy is unavailable or its required session credentials are gone. Unsafe or newer
profile documents are held unchanged. A failed teardown does not release native
geolocation until Off successfully commits.

These notes describe the 1.1.3 schema-4 release candidate. Its implementation was merged in PR #76; the separate release PR sets version 1.1.3. No tag, submission, signing or publication is implied by these notes. Earlier
versions retain their immutable tagged source archives for historical review.

## Install channel

Listed releases use AMO for public installation and automatic updates. The candidate
preserves unlisted signing as described below. Each GitHub Release remains draft until its
exact AMO file is public and the Mozilla signature has been verified. Its primary installer is the exact XPI downloaded from
Mozilla, hash-checked and permanently installed in signature-enforcing normal Firefox.
No unsigned submission ZIP is presented as a signed installer. Source and provenance
refer to the same tag, version and commit. See `docs/RELEASING.md`.

## Listing assets

Four listing screenshots are captured from the actual extension UI in a clean Firefox
candidate profile with deterministic local fixtures: active popup, audit state, profile
options, and coordinate picker. The candidate may be unsigned; its capture provenance
must say so. These screenshots demonstrate UI behavior, not Mozilla signing or approval.
No personal credentials, real public IP, unrelated extensions or invented status badges
may appear. Preparing these assets does not require a signed build; publication of the
installer still requires every signing/finalization gate.

The committed PNGs are:

1. [`01-active-profile.png`](../store-assets/screenshots/01-active-profile.png)
2. [`02-profile-management.png`](../store-assets/screenshots/02-profile-management.png)
3. [`03-identity-audit.png`](../store-assets/screenshots/03-identity-audit.png)
4. [`04-local-location-picker.png`](../store-assets/screenshots/04-local-location-picker.png)

[Capture metadata](../store-assets/screenshots/metadata.json) records Firefox 158.0 on
Linux, candidate extension version 1.1.3, dark theme, source/image hashes and the
`Tokyo · Local demo` fixture: loopback proxy, GeoIP disabled, no credentials, synthetic
coordinates and timezone. The popup is the real 380px UI centered on a plain 1280×800
canvas; options retain their normal layout. [Asset instructions](../store-assets/README.md)
explain deterministic icon generation and screenshot reproduction.

## After a review comment

Fix the code on a branch, merge through CI, bump `package.json` and `public/manifest.json` together, and push a new `vX.Y.Z` tag. Do not move or reuse the rejected tag. `npm run check:version` rejects a repeated or older version.

## Version 1.1.1 distribution

This version retains the 1.1.0 product behavior and privacy model. It adds unlisted
Mozilla signing for self-distribution through GitHub Actions. Existing listed submissions
are preserved. The signed artifact is downloaded unchanged from Mozilla, verified against
AMO SHA-256 and the tagged production payload, and installed in normal Firefox with
signature enforcement before publication. No custom update URL is added. Unlisted signing
is not public listing approval, and GitHub does not provide automatic extension updates.

## Version 1.1.2 security update

This unlisted submission adds fail-closed proxy routing. Firefox receives a terminal
proxy list, preventing a failed selected proxy from falling back to its system proxy.
An async blocking request listener prevents external requests from going direct while
the durable route is unreadable or unsafe. A local, non-secret applied route survives
full Firefox restarts independently of the editable saved profile and session password.
Outage, event-page restart, full restart, authentication loss, and recovery are covered
by real Firefox tests for HTTP, HTTPS, WS, WSS and proxy DNS. The normal-user GitHub
installer is published only after Mozilla signing and permanent installation checks.

## Version 1.1.3 candidate: credentials and SOCKS health

Both username and password are stored only in `storage.session`, including the active
session snapshot. The options fields load blank; both blank preserve the saved pair,
either entered field replaces the pair, and Clear removes the saved pair/marker. Save
does not change the applied target; Apply activates the saved revision. Duplicate copies
no credentials. Tests cover v3 saved-versus-applied migration and old session snapshots.

Passive SOCKS observations correlate request ID, generation, sanitized proxy endpoint
and destination hostname. Generic network errors can only produce suspicion; proxyInfo
does not prove a completed handshake. Three failure buckets across two destinations in
five seconds mark suspect; three uncached successes spanning one second establish
recovery. At most 512 requests/30 seconds are retained. A single shared timer delays at
most 128 new SOCKS decisions, with a 250–2000 ms cooldown; overflow uses the same route
immediately. Routing is recomputed on release. No HTTP replay, route switch, public probe,
identity reset or durable telemetry occurs. `failoverTimeout: 1` is Gecko retry suppression,
not a connection deadline. See `docs/ARCHITECTURE.md` for source references and limitations.
The required `e2e:flap` gate covers three repeated outage/recovery cycles with zero
fallback sentinel hits, alongside existing startup, restart and credential-loss checks.

## Data declaration correction

The candidate declares required `locationInfo` and `authenticationInfo`, retaining optional
`personallyIdentifyingInfo`. Authentication data is the existing username/password sent
only to the user-selected proxy; this adds no new transmission, telemetry or API permission.
Mozilla's [taxonomy](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
explicitly categorizes usernames and passwords as authentication information. Required
consent may therefore change the installation/update prompt; no silent upgrade is promised.
This documentation is not a claim of Mozilla approval. Firefox desktop 140.0 is the
minimum for the built-in consent system; no maximum version or Android support is added.
