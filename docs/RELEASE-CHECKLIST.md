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
- [ ] Proxy usernames and passwords are absent from `storage.local`, from every page context and from
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
- [ ] Save without changing runtime, then Save and enable the visible form. A page's geolocation matches the selected point and the page
      timezone matches the chosen zone.
- [ ] Before **Load online map**, confirm the local grid and typed coordinates work
      without map requests. Enable the map explicitly and confirm real streets/labels,
      visible OpenFreeMap/OpenMapTiles/OpenStreetMap attribution, and coordinate selection.
- [ ] Disable the online map or simulate provider/WebGL failure. The local grid and typed
      coordinates remain usable, selected coordinates survive, and no success claim is
      shown for missing imagery. GeoIP and basemap enablement are separate controls.
- [ ] Verify map requests omit cookies/referrer/explicit proxy credentials and use only
      validated OpenFreeMap HTTPS resources. Selected proxy routing is retained; missing
      required credentials or a provider-host bypass prevents loading. Direct/Off map
      loading requires optional personal-data consent. Do not equate this with control of
      every Firefox-protected browser-service request.
- [ ] Apply/Off, permission revocation, editor closure and background restart invalidate
      map authorization; a remembered preference must obtain a fresh checked session, never restore an old session from durable storage.
- [ ] Run `e2e:map-fallback` and the actual WebGL `e2e:map` rendering gate. The latter
      needs a display/Mesa context (CI uses Xvfb); a no-WebGL fallback pass cannot satisfy
      the imagery gate. Test trust roots are confined to disposable harness profiles.

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
(invariants, websocket, proxy-auth, ui, fail-closed, restart, socks-auth, flap), plus
green required CI on exact merged main.
Do not require a signed artifact before submitting its new version for signing.

After approval: verify exact AMO public version/channel, unchanged downloaded XPI hash,
manifest ID/version, production payload and normal Firefox permanent signature-enforcing
installation. Only then finalize the public GitHub Release. Pending review is an external
blocker, never a successful user release. Verify canonical AMO URL and default update
channel, then update README in a separate documentation PR if needed.

## Quick-setup candidate additions

- [ ] Valid endpoint typing previews only the draft proxy; ordinary traffic remains on
      the active route. Closing/editing cancels stale results and does not save a profile.
- [ ] Wrong proxy credentials can be corrected; an unreachable draft never falls back
      to the active route or Direct. Options GeoIP Disabled suppresses draft checks.
- [ ] Save remains non-activating; Save and enable uses the current form, including
      credentials, exactly once. A failed save must not activate stale data.
- [ ] Previously chosen DNS, WebRTC and manual identity settings survive upgrade.
- [ ] First online-map enablement is explicit; remembered loading rechecks current
      route/credentials/consent. Unload/uncheck clears it; no hidden retry loop occurs.
- [ ] English/Chinese, light/dark, narrow-window layout and keyboard controls pass;
      owner accepts the actual final UI before publication.
- [ ] Reviewer metadata and privacy copy disclose automatic draft lookup and remembered
      map loading; no unchanged-runtime or no-lookup-before-activation claim remains.
- [ ] `e2e:draft` and its deterministic `--delayed-init` variant pass alongside the other ten Firefox harnesses.

## Candidate-specific checks

- [ ] Schema-4 migration removes legacy usernames from both saved and applied profiles,
      preserving an applied proxy when a newer saved revision is Direct
- [ ] Both blank credential fields preserve the session pair; either field replaces it;
      Clear affects runtime only after Apply; Duplicate carries no credential values
- [ ] `e2e:flap` passes all three outage/recovery cycles and direct sentinels remain zero
- [ ] Suspected proxy-health wording does not claim transport outage or guaranteed
      recovery timing; failed HTTP requests are never replayed
- [ ] Required data declarations include the existing authentication transmission to the
      user-selected proxy; new/update consent prompts are not described as silent
- [ ] Four store screenshots show actual fixture UI, with unsigned-candidate provenance
      when applicable; screenshots are not evidence of Mozilla approval or signature
- [ ] Authenticated AMO state confirms the next patch version is unused before the
      separate version PR. Do not infer availability from Git tags alone

## Historical 1.1.3 listed-release plan

- [ ] Confirm package, lockfile and manifest remain 1.1.3 and the tagged release-config
      selects listed; do not alter historical 1.1.1/1.1.2 submissions or assets
- [ ] Recheck authenticated AMO status immediately before submission. The earlier
      [status run](https://github.com/jacek4yang/net-identity/actions/runs/36807778410)
      reported 1.1.3 absent at 02:51:21 UTC on 2026-10-01; the
      [04:20:22 UTC recheck](https://github.com/jacek4yang/net-identity/actions/runs/36814633282)
      again found it absent. Neither check reserves the version
- [ ] Verify dual-mode SOCKS rejects ordinary fixture traffic while credentials are
      missing, then restores authenticated access after Save and Apply
- [ ] Keep Firefox-protected browser-service anonymous-access limitations visible in
      reviewer notes, privacy text and listing; do not claim a browser-wide kill switch
- [ ] After exact listed-version approval and release finalization, run the separate
      listing publisher dry-run, review its plan and publish only the reviewed copy/media
- [ ] Visually inspect the public listing and rendered media; report moderation/cache
      delay honestly and do not equate accepted uploads with public visibility

## Future listed map releases

- [ ] Merge the reviewed map implementation only after `quality` and `firefox / invariants`
      pass on its exact head, including both map gates and existing network regression suites
- [ ] Recheck owner-visible AMO version history and remote tags before selecting a new
      version. Version 1.1.5 is already approved and published; v1.1.4 remains an immutable
      failed submission attempt. Do not reuse either tag or treat v1.1.4 as pending review
- [ ] Keep reviewer notes at or below Mozilla's 3,000-character limit; run the metadata
      guard and boundary tests. Link full tagged docs instead of expanding API notes
- [ ] In that separate release PR, align package, lockfile and manifest to the next
      confirmed-unused version, retain `listed`, and update reviewer metadata/privacy/listing
      copy for opt-in OpenFreeMap traffic, viewed-region/IP disclosure and packaged MapLibre
- [ ] Include readable tagged source, pinned MapLibre version, bundled worker and dependency
      notices; preserve data-only remote resources and disabled external worker plugins
- [ ] Regenerate any changed store screenshots from actual UI with honest provenance.
      Preserve v1.1.3 publication evidence and do not treat manually uploaded AMO preview IDs
      as a trusted listing-workflow receipt or automatically overwrite/adopt them
- [ ] After merging the release PR, rerun quality/package, all fourteen deterministic Firefox
      suites and required CI on the exact clean main commit; create a new immutable tag only
      after these gates pass. Do not change v1.1.3 or any historical submission/assets
- [ ] Use the existing listed submission/finalizer, then verify permanent signed installation
      and public AMO/GitHub release evidence. Update current-release docs only after publication

### Encrypted vault

- [ ] Enable from actual UI with matching master passwords; wrong confirmation writes nothing.
- [ ] Full Firefox exit locks active traffic; wrong password preserves data; unlock restores only applied configuration.
- [ ] Event-page suspension does not require re-entry. A previously Off route remains Off.
- [ ] Inspect durable storage for ciphertext only, and test encrypted backup on an empty installation.
- [ ] Keep historical failures and run vault UI + vault authenticated full-restart harnesses on the release head.
