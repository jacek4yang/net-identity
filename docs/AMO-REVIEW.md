# Notes for addons.mozilla.org review

The extension id is `net-identity@jacek4yang.github.io` and does not change between versions.

## Permissions

- `proxy` and `<all_urls>`: `proxy.onRequest` decides the proxy for `http`, `https`, `ws`, and `wss`. Host permission is required for that listener. Other schemes stay direct.
- `webRequest` and `webRequestBlocking`: HTTP/HTTPS proxy passwords. The extension answers a challenge only when Firefox reports a proxy challenge whose host and port both match the active proxy, and only once per request. SOCKS passwords use `ProxyInfo` and are not sent through `onAuthRequired`.
- `privacy`: read and set `webRTCIPHandlingPolicy`, then `clear()` on deactivation so Firefox restores the previous value. If another extension or policy controls the setting, this extension does not overwrite it.
- `storage`: profiles in `storage.local` (never the proxy password) and session-only secrets in `storage.session`.
- Data collection: required `locationInfo` for the egress lookup. Optional `personallyIdentifyingInfo` before a browser-routing profile may send the user's own public IP. See `docs/PRIVACY.md`.

## Page behaviour

Content scripts run in every frame, including `about:blank`. The MAIN-world script patches `Date` / `Intl` and `navigator.geolocation` for the active profile. Proxy passwords are not sent to pages. While a profile is activating, failing, or active, the geolocation shim does not call Firefox's implementation.

A sandboxed frame Firefox refuses to inject can still see the computer's timezone and location. That is a platform limit.

## Map

The options map is a bundled local coordinate grid. No external tile provider is enabled,
no images are fetched, and no remote executable code is loaded. Coordinate entry, marker
drag, selection, panning and zoom work offline. See `docs/TILE-POLICY.md` for the decision.

The built-in Direct route exists virtually on fresh install; it does not trigger lookup.
Direct switches without optional consent and withholds GeoIP until permission is granted.
Custom policies can disable GeoIP and make geolocation unavailable without native fallback.
Save persists configuration; Apply changes runtime. Version-1 profiles migrate to schema 2.
Apply uses the saved revision without saving unsaved form values. Applied configuration
and credentials survive event-page suspension in session storage. Unsafe or newer
profile documents are held unchanged. A failed teardown does not release native
geolocation until Off successfully commits.

These notes describe version 1.1.0 and its schema-2 migration. Use the immutable v1.0.0 tagged
source archive when reviewing that historical version.

## Install channel

AMO is the canonical listed install and automatic-update channel. The GitHub Release
remains draft until approval. Its primary installer is the exact XPI downloaded from
Mozilla, hash-checked and permanently installed in signature-enforcing normal Firefox.
No unsigned submission ZIP is presented as a signed installer. Source and provenance
refer to the same tag, version and commit. See `docs/RELEASING.md`.

## Listing assets

After approval, refresh listing screenshots from a clean signed build, with no
other extensions and no personal data on screen:

- the popup with an active auto profile (public IP, location, timezone, audit verdict);
- the audit showing a stale or externally controlled aspect;
- the options profile list;
- the location map with a selected point.

Do not screenshot a developer build, and do not add badges or claims the extension does
not verify.

## After a review comment

Fix the code on a branch, merge through CI, bump `package.json` and `public/manifest.json` together, and push a new `vX.Y.Z` tag. Do not move or reuse the rejected tag. `npm run check:version` rejects a repeated or older version.
