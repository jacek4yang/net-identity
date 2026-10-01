# Notes for addons.mozilla.org review

The extension id is `net-identity@jacek4yang.github.io` and does not change between versions.

## Metadata-fix release 1.1.5

The immutable v1.1.4 submission attempt failed before an AMO version or review existed.
Its reviewer notes exceeded the official 3,000-character model limit; the hidden API
response was not retained, so the exact server rejection was not observed. This release
shortens notes and adds a pre-submission metadata guard without changing runtime behavior.
The v1.1.4 tag and draft evidence remain intact. Fresh versioned 1.1.5 capture passed
artifact, runtime-hash and independent visual verification; evidence is linked below.

## Permissions

- `proxy` and `<all_urls>`: `proxy.onRequest` decides the proxy for `http`, `https`, `ws`, and `wss`. Host permission is required for that listener. Other schemes stay direct.
- `webRequest` and `webRequestBlocking`: HTTP/HTTPS proxy passwords and fail-closed routing. The extension answers a challenge only when Firefox reports a proxy challenge whose host and port both match the active proxy, and only once per request. SOCKS passwords use `ProxyInfo` and are not sent through `onAuthRequired`. During startup, the blocking request listener cancels external requests if a committed proxy route cannot be reconstructed safely.
- `privacy`: read and set `webRTCIPHandlingPolicy`, then `clear()` on deactivation so Firefox restores the previous value. If another extension or policy controls the setting, this extension does not overwrite it.
- `storage`: profiles in `storage.local` (never proxy usernames or passwords) and session-only secrets in `storage.session`.
- Data collection: required `locationInfo` for the egress lookup and, in the unreleased map implementation, the explicitly viewed OpenFreeMap area; `authenticationInfo` covers existing credentials sent to the selected proxy. Optional `personallyIdentifyingInfo` before a browser-routing profile may send the user's own public IP. See `docs/PRIVACY.md`.

## Page behaviour

Content scripts run in every frame, including `about:blank`. The MAIN-world script patches `Date` / `Intl` and `navigator.geolocation` for the active profile. Proxy usernames and passwords are not sent to pages. While a profile is activating, failing, or active, the geolocation shim does not call Firefox's implementation.

A sandboxed frame Firefox refuses to inject can still see the computer's timezone and location. That is a platform limit.

## Map (1.1.5 candidate, unreleased source change after 1.1.3)

The published 1.1.3 package remains the offline-only grid. The new implementation adds
an explicit **Load online map** action using locally bundled MapLibre GL JS and worker;
OpenFreeMap supplies only data from `https://tiles.openfreemap.org`. No network request
is made just by installing the extension or opening the editor. No remote JavaScript,
RTL plugin or native GeolocateControl is enabled. Coordinate entry and existing gestures
remain available when WebGL or the network fails.

Online map requests disclose the viewed area and visible egress IP to OpenFreeMap/CDN.
Direct/Off requires optional `personallyIdentifyingInfo`; proxied requests retain the
selected proxy and missing-credential/terminal-null protections. Provider bypasses refuse
map loading. A typed, bounded background broker rejects redirects and unapproved resources,
omits credentials/cookies/referrers, and cancels stale-generation loads. Closing/switching
the editor, route changes, permission revocation and background restart require a fresh
map enable action. The renderer and third-party notices are packaged locally; attribution
links OpenMapTiles and OpenStreetMap. See `docs/TILE-POLICY.md` and `docs/PRIVACY.md`.

CJK ideographs use brokered provider glyph data (`localIdeographFontFamily: false`),
so map labels do not depend on operating-system CJK fonts. Validated resource URLs are
serialized once with `URL.href` for both fetching and pending-request correlation,
including encoded font-stack spaces. A renderer FIFO admits at most 8 active broker
requests and 256 waiting URL/control records, with a 60-second queue-inclusive deadline;
it caches no response bytes, never retries and cancels on removal. Aborted active work
retains its slot until the broker RPC settles. Existing broker/network/byte bounds remain
unchanged. Glyph errors stay visible instead of being erased by a later load event.

Renderer dependency: **MapLibre GL JS 6.11.2**, pinned in the lockfile and bundled
from its local ESM distribution. The earlier unpublished 5.24.0 candidate was rejected
because it falls within [GHSA-jrc7-96c5-q579](https://github.com/maplibre/maplibre-gl-js/security/advisories/GHSA-jrc7-96c5-q579)
(affected versions through 6.4.0; fixed from 6.4.1). The patched upstream version is
used rather than relying solely on disabling its vulnerable attribution entry point.

The upstream worker includes an optional external-plugin script loader. Before
bundling, the build replaces that **complete loader function** with an explicit
fail-closed throwing stub. The transformation verifies exact upstream source hashes
and a single full-function match; unexpected source changes fail the build. This is
a documented reproducible hardening transform, not a relaxation of CSP or the all-script
no-eval scan. External worker plugins, including dynamically loaded RTL plugins, are
unsupported. Core map data rendering does not need that loader.

MapLibre source, worker, CSS and license hashes are verified before packaging, and
renderer/dependency notices are shipped locally. Fixed attribution links use local
`textContent`; application code does not use Popup HTML APIs or upstream attribution
HTML. The new vendor bundle produces **zero vendor lint warnings**: the previous
three-warning exception was removed entirely. The existing desktop/Android-floor
warning remains explicitly documented; all other unexpected warnings fail the gate.

Do not apply these new provider disclosures or map screenshots to the immutable 1.1.3
submission. Update candidate metadata/assets only when the next map release is selected;
actual test outcomes and the final pinned renderer version must be recorded before submission.

The built-in Direct route exists virtually on fresh install; it does not trigger lookup.
Direct switches without optional consent and withholds GeoIP until permission is granted.
Custom policies can disable GeoIP and make geolocation unavailable without native fallback.
Save persists configuration; Apply changes runtime. Version-1, version-2 and version-3 profiles migrate to schema 4. Legacy usernames become a non-secret authentication-required flag; the value is removed from both saved and applied profiles.
Apply uses the saved revision without saving unsaved form values. Applied configuration
is also recorded without credentials in local storage so a full Firefox restart cannot
activate a newer unapplied Save. Session credentials survive event-page suspension but
are removed on full exit. A selected proxy stays selected, and ordinary extension-observable traffic fails,
when the proxy is unavailable or its required session credentials are gone. Unsafe or newer
profile documents are held unchanged. A failed teardown does not release native
geolocation until Off successfully commits.

## Historical 1.1.3 submission context

The following version-specific notes record the earlier submission. Version 1.1.3
is now approved and published, as recorded in `docs/RELEASING.md`; its package has no
MapLibre dependency. New map-release reviewer metadata will be selected separately.

These historical notes described the 1.1.3 schema-4 release candidate. Its health/credential implementation was merged in PR #76 and its ordinary-request missing-credential gate in PR #78; the separate release PR sets version 1.1.3 and selects listed distribution. No tag, submission, signing or publication is implied by these notes. Earlier
versions retain their immutable tagged source archives for historical review.

## Install channel

Listed releases use AMO for public installation and automatic updates. The provisional
1.1.5 map candidate selects listed distribution; this does not imply submission, review
approval or signing. Public 1.1.3 remains the released offline-picker version. Historical
listed 1.1.0/1.1.3 and unlisted 1.1.1/1.1.2 assets/submissions remain unchanged. Each
GitHub Release stays draft until its exact AMO file is public and the Mozilla signature
has been verified. Its primary installer is the exact XPI downloaded from Mozilla,
hash-checked and permanently installed in signature-enforcing normal Firefox.
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

[Capture metadata](../store-assets/screenshots/metadata.json) records stable Firefox
157.0 on Linux, unsigned candidate 1.1.5, dark theme and the synthetic `Tokyo · Local demo`
profile (loopback endpoint, disabled GeoIP and no credentials). The final
[capture run](https://github.com/jacek4yang/net-identity/actions/runs/36863012728) used
production source `e5bb71c3fbcd777755a00a231d6e0da54ec2892d` and actual OpenFreeMap
geography. Four 1280×800 images and nine UI/renderer hashes match the production package.
[Visual review](../store-assets/screenshots/capture-review.json) confirms readable Tokyo
CJK labels, local SVG power icon, complete map fieldset, attribution and privacy-safe
fixture content. The raw capture review-required flag is preserved; adjacent review
records completion. No signed-release or listing-publication claim follows from capture.
Historical 1.1.3 images remain in that immutable tag and its publication record.

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

## Missing-credential fail-closed check

The blocking request listener cancels non-bypassed ordinary extension-observable
HTTP/HTTPS/WS/WSS and GeoIP traffic when the
applied proxy requires authentication but its session credential pair is missing. It does
not rely on the upstream proxy refusing anonymous access: an endpoint accepting both
modes could otherwise change egress identity without changing its host or port.
Terminal-null routing still prevents direct/system fallback. A matching active session
snapshot restores the pair after event-page suspension; after full Firefox exit, the
user must save the pair and Apply it. Save alone does not change applied credentials.
Firefox-protected browser-service requests are outside this cancellation boundary.
Firefox 158 Remote Settings requests could still attempt anonymous access to the same
selected proxy through `proxy.onRequest`. No Direct fallback is added; a server accepting
anonymous clients may nevertheless assign them a different identity. Browser-wide account
identity requires server-side rejection of anonymous access; this is not a universal kill
switch. The dual-mode fixture records and rejects browser-service attempts locally,
asserts zero ordinary-fixture CONNECTs/origin hits without credentials, and requires the
pre-fix negative control to fail. See docs/SECURITY.md for official source references.

## HTTP/HTTPS proxy account identity

The proxy server must enforce authentication. Keeping a username/password pair in the
session does not prove every HTTP/HTTPS proxy connection used that account: a server
accepting anonymous CONNECT requests may not issue a 407 challenge. This applies to
ordinary webpage and map traffic too, independently of the Firefox-protected service
limitation. Require the server to reject anonymous access when account identity matters.
This is not a Direct fallback or a guarantee of reauthentication of existing connections.
