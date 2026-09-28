# Release-candidate checklist

This checklist separates pre-submission validation from post-approval installation. Run it on the exact release candidate, in a clean
**normal Firefox** profile (not only Developer Edition), before a stable tag where possible; signed installation is verified after AMO approval. Record the
result in the GitHub Release notes for that version. A failed security or correctness
item blocks the stable release.

`npm run check` and the `firefox / invariants` CI job cover the logic and the
deterministic browser invariants. The items below need a human because they use the UI,
a signed build, a real proxy or a second Firefox version.

## 0. Prepare

- [ ] `git switch` to the exact release commit, then `npm ci && npm run check`.
- [ ] Confirm the release gate is green on that commit: `quality` and
      `firefox / invariants` (see `docs/CI.md`).
- [ ] Start a **clean normal Firefox profile** with no other extensions.
- [ ] Note the Firefox version: `________`.

## 1. Install and first run

- [ ] Install through the normal signed/AMO path when a listed build is available. If the
      listing is still waiting for Mozilla review, record that here and install the
      candidate via `about:addons` in a build that permits it.
- [ ] The first run shows guidance and makes **no** GeoIP request.
- [ ] Complete first-run guidance; confirm a fresh install made no profile and no request
      to the location service (check the network log).

## 2. Profiles

- [ ] Activate the reserved virtual **Direct** route without optional GeoIP consent; no lookup occurs.
- [ ] Create an **authenticated HTTP proxy** profile (use `scripts/dev-proxy.mjs
--require-auth user:pass` or a real proxy) and activate it.
- [ ] Create a **manual-location** profile with a chosen point, timezone and accuracy.

## 3. Network behaviour

- [ ] HTTP and HTTPS requests follow the active proxy.
- [ ] `ws` and `wss` follow the active proxy; a loopback WebSocket stays direct.
- [ ] The proxy password is absent from `storage.local`, from every page context and from
      the browser console. (`about:debugging` → inspect → storage.)
- [ ] Off releases routing, WebRTC and synthetic identity without making a lookup.

## 4. Identity correctness

- [ ] While a profile is activating and while the provider fails, page geolocation stays
      unavailable and never returns the computer's real position.
- [ ] While a manual profile is active, `Date`, `Intl.DateTimeFormat()`,
      `getTimezoneOffset()` and `navigator.permissions.query({name:"geolocation"})` are
      consistent with the profile.
- [ ] A supported same-origin frame and a `srcdoc` frame see the same timezone and
      geolocation as the top page. Note any frame Firefox refuses to inject.
- [ ] WebRTC: the policy applies on activation, reports the effective value, and returns
      to the value from before activation on deactivation.

## 5. Options map

- [ ] Open the Options map and **click/select** a location. The centre pin and the
      latitude/longitude fields stay on the same point.
- [ ] Pan and zoom without changing the selected coordinates; drag the marker to change
      selection. Type coordinates and confirm the marker and viewport update.
- [ ] Save without changing runtime, then Apply the saved revision. A page's geolocation matches the selected point and the page
      timezone matches the chosen zone.
- [ ] Use offline mode (there is no external tile provider) and repeat the click and the typed
      coordinates. Both still update the fields and can be saved.

## 6. Upgrade and persistence

- [ ] Start from a previous-schema fixture/version and confirm valid profiles survive and
      an unsafe/unparseable document leaves the extension idle instead of direct.
- [ ] Restart Firefox with the selected proxy unavailable. The active profile
      remains selected; HTTP/HTTPS/WS/WSS fail and the recording direct origin
      receives zero requests. Restart the proxy and confirm recovery without
      switching routes.

## 7. Audit

- [ ] The audit reflects the active tab and frame state.
- [ ] Change Firefox's own proxy or WebRTC setting externally and confirm the audit
      updates without the extension rewriting the setting or reactivating the profile.
- [ ] Confirm a stale frame is named instead of being hidden by a current one.

## 8. Ordinary-user install path

- [ ] Follow the README install path as a non-developer would. It points to AMO first and
      clearly separates the developer instructions.

## Recording the result

| Version | Commit | Firefox | Result | Notes |
| ------- | ------ | ------- | ------ | ----- |
|         |        |         |        |       |

A failed item is fixed on a branch, merged through CI, and shipped as a **new** version
and tag. Never move or reuse a rejected tag.

## Distribution gates

Before tag: `npm ci`, `npm run check`, `npm run package` and every Firefox E2E
(invariants, websocket, proxy-auth, ui, fail-closed, restart, socks-auth), plus
green required CI on exact merged main.
Do not require a signed artifact before submitting its new version for signing.

After approval: verify exact AMO public version/channel, unchanged downloaded XPI hash,
manifest ID/version, production payload and normal Firefox permanent signature-enforcing
installation. Only then finalize the public GitHub Release. Pending review is an external
blocker, never a successful user release. Verify canonical AMO URL and default update
channel, then update README in a separate documentation PR if needed.
