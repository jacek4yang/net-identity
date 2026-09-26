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

The options map is local code. Optional images come from `tile.openstreetmap.org` with `referrerpolicy="no-referrer"`, and only while that page is open. No remote script is loaded. Coordinates can be typed when images fail.

## Install channel

Listed AMO submission is the install and update channel for ordinary Firefox users. A GitHub Release records the tested tag, the source archive, and checksums. The unsigned package attached there is the submission artifact, not a signed replacement for the AMO install.

## Listing assets

Capture the listing screenshots from a clean signed build at submission time, with no
other extensions and no personal data on screen:

- the popup with an active auto profile (public IP, location, timezone, audit verdict);
- the audit showing a stale or externally controlled aspect;
- the options profile list;
- the location map with a selected point.

Do not screenshot a developer build, and do not add badges or claims the extension does
not verify.

## After a review comment

Fix the code on a branch, merge through CI, bump `package.json` and `public/manifest.json` together, and push a new `vX.Y.Z` tag. Do not move or reuse the rejected tag. `npm run check:version` rejects a repeated or older version.
