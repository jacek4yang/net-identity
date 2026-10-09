# AGENTS.md

Operating notes for coding agents (Grok Build, Codex, Claude Code, Pi Agent, …) and
for humans working on `net-identity`.

## 1. What this project is

A **Firefox-only** extension that keeps one _network identity_ consistent: proxy,
observed public egress IP, GeoIP location, page-visible geolocation, page-visible
timezone, and WebRTC IP handling.

The unit of work is a **profile**. Activating a profile applies all of those together,
resolves the identity from the _observed_ egress IP, and broadcasts it to pages.

## 2. Hard constraints

- **Firefox only.** No Chrome/Edge/Safari code paths, no cross-browser shims, no
  `webextension-polyfill`. Use the native `browser.*` APIs.
- **Manifest V3 with a Firefox event page**: `"background": { "scripts": [...], "type": "module" }`.
  Never `background.service_worker`, never MV2.
- **One reviewed runtime dependency:** pinned `maplibre-gl@6.11.2`, explicitly requested for the real map picker. Its ESM code, CSS, worker and licence notices ship locally. The build verifies upstream source hashes and replaces the complete optional external worker-plugin loader with a denying stub; no runtime code is fetched or evaluated. Do not remove this guard or regress to versions affected by GHSA-jrc7-96c5-q579 (through 6.4.0). No other runtime dependencies without review.
- **No frameworks.** UI is plain HTML/CSS/TypeScript, no React/Vue/Svelte/Redux, no
  WXT/Plasmo/Webpack/Babel.
- **No remote code, no telemetry, no `eval`/`new Function`.** The build script fails
  if `eval`/`new Function` appears in any shipped script, including the options vendor and worker.
- Minimum Firefox is **140.0**. `world: "MAIN"` exists from 128, but 140 is the
  desktop floor for Firefox's built-in data-collection consent. One consent system,
  not a custom fallback for older Firefox. Do not add a `strict_max_version`.
- **Toolchain ceiling:** TypeScript is pinned to the 6.x line because
  `typescript-eslint@8.x` declares `peerDependencies.typescript: ">=4.8.4 <6.1.0"`.
  TypeScript 7 breaks `npm ci` and type-aware linting, so Dependabot is configured to
  ignore `typescript >= 7.0.0` (`.github/dependabot.yml`). Lift that rule only when
  `typescript-eslint` supports it.
- Node.js **>= 22** is required by `web-ext` 10 and asserted in `package.json`.

## 3. Architecture

```
UI (popup, options)  ──runtime.sendMessage──▶  background (event page)
                                                   │
content/bridge.js (isolated)  ◀──tabs.sendMessage──┤
        │ window.postMessage                       │
        ▼                                          ▼
content/page-shim.js (MAIN world)          proxy.onRequest / webRTCIPHandlingPolicy
```

| Path                              | Responsibility                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/background/index.ts`         | **The only file that touches `browser.*` in the background.** Wiring + listeners.                        |
| `src/background/identity.ts`      | `ActivationController`: the activation lifecycle, generation tokens, audit composition.                  |
| `src/background/proxy.ts`         | Pure proxy engine: `ProxyInfo` mapping, bypass matching, auth decisions, Firefox proxy-settings reader.  |
| `src/background/credentials.ts`   | Session-only credential store (`storage.session`).                                                       |
| `src/background/active-target.ts` | Session snapshot of the active target (survives event-page suspension).                                  |
| `src/background/webrtc.ts`        | `privacy.network.webRTCIPHandlingPolicy` controller (respects `levelOfControl`).                         |
| `src/background/messages.ts`      | Message router: sender checks, validation, profile CRUD.                                                 |
| `src/content/bridge.ts`           | Isolated-world bridge between the background and the page.                                               |
| `src/content/page-shim.ts`        | MAIN-world orchestrator (installs shims, applies identity).                                              |
| `src/content/timezone-shim.ts`    | Date/Intl patching.                                                                                      |
| `src/content/geolocation-shim.ts` | `navigator.geolocation` patching.                                                                        |
| `src/profile/`                    | Profile model, validation (the only place profile rules live), storage.                                  |
| `src/geo/`                        | GeoIP provider interface + the `ipwho.is` implementation.                                                |
| `src/shared/`                     | Result type, primitives, timezone maths, public identity contract, state types, audit, DOM helpers.      |
| `src/options/form.ts`             | Pure form → profile mapping (unit tested; keeps the DOM layer thin).                                     |
| `src/options/location-map.ts`     | Pure Web Mercator maths; map-model.ts owns interactions. online-map.ts only decorates the shared camera. |

## 4. Firefox API decisions that must not be "simplified"

These were verified against MDN/browser-compat-data. Breaking them breaks the
extension in ways tests will not catch:

1. **`proxy.onRequest` requires host permissions** matching the intercepted URLs — that
   is why `<all_urls>` is in `host_permissions`. Removing it silently disables proxying.
2. **`ProxyInfo.username`/`password` work only for `socks` (SOCKS5).** HTTP/HTTPS proxy
   credentials use `proxyAuthorizationHeader` (preemptive) and `webRequest.onAuthRequired`
   (challenge). `proxyDNS` is honoured only for `socks4`/`socks`. SOCKS4 cannot
   authenticate at all.
3. **`{ type: "direct" }` does not override a user-configured Firefox proxy.** The audit
   therefore reports Firefox's own `proxy.settings` value separately (`firefox_proxy`).
4. **`onAuthRequired` is only fired for HTTP/HTTPS proxies, never SOCKS.**
5. **The MV3 background page can be suspended.** The active target is mirrored into
   `storage.session`, but that area is lost after a full browser exit. The request
   listener must recover the durable desired route from `storage.local`; a missing
   or invalid session snapshot can never imply Direct. Unsafe durable state is
   blocked by the `webRequest.onBeforeRequest` gate.
6. **`proxy.onRequest` may return a Promise.** The cold-start fallback depends on it.
7. **`content_scripts[].world: "MAIN"` requires Firefox 128+**. The manifest floor is
   **140.0** because that is when Firefox shows built-in data-collection consent.
8. **`data_collection_permissions` is enforced by the 140 floor.** Required
   `locationInfo` and `authenticationInfo` are declared for built-in consent. Optional `personallyIdentifyingInfo` is
   requested from a user gesture before a _direct_ profile may send the user's own
   public IP to the GeoIP provider. Do not call the provider when that grant is absent.
9. **`proxy.onRequest` sees `ws:` and `wss:` as well as `http:`/`https:`.**
   `parseRequestUrl()` treats all four as proxyable network traffic and applies the same
   bypass list. Other schemes (`moz-extension`, `about`, `file`, `data`, `blob`, `ftp`,
   …) stay `{ type: "direct" }`. Do not narrow this back to http(s): a page can otherwise
   leave the active proxy by opening a WebSocket. `<all_urls>` already matches those
   schemes, which is why the listener filter is not a shorter http-only list.

## 5. Profile activation lifecycle

`ActivationController.activate()` is one atomic transition:

```
validate profile
  -> set proxy routing in memory (effective immediately)
  -> persist the session snapshot (so a restart cannot fall back to "direct")
  -> apply WebRTC policy
  -> resolve identity from the OBSERVED egress IP (never from the proxy hostname)
  -> persist derived values back into the profile (auto mode only)
  -> probe open tabs for their applied generation
  -> broadcast the public identity, then the state
```

- Every activation increments `generation`. Any response belonging to an older
  generation is discarded (see `tests/activation.test.ts`).
- The previous in-flight lookup is cancelled through an `AbortController`.
- Identity is never derived from the proxy server's hostname.
- `deactivate()` clears routing, calls `webRTCIPHandlingPolicy.clear()` so Firefox
  restores the previously effective value, clears the snapshot and publishes
  `payload: null` with `controlled: false` so pages revert to native behaviour.
- Later changes to Firefox's proxy settings or WebRTC policy recompute the audit
  only. The listeners do not write those settings again and do not reactivate the
  profile. An `onChange` that matches the value this extension just published is ignored.
- Until that idle envelope is committed — including during startup, activation,
  refresh and provider failure — the geolocation shim does not call Firefox's
  implementation. It keeps the previous synthetic position when it has one.
- Failed teardown clears the departed route's identity and remains controlled until
  Off successfully commits. Diagnostics must use the current routing generation.

## 6. Security invariants (do not weaken)

When a proxy profile is the committed desired route, proxy unavailability may reduce
availability but must never reduce routing confidentiality by falling back to Direct:
`proxy unavailable -> no network`. The selected profile stays selected through proxy
errors, GeoIP failures, event-page suspension and full Firefox restarts. The durable
non-secret applied route, rather than a newer unapplied Save, controls cold routing.

**Fail-closed routing is mandatory.** Once the user selects a proxy profile,
HTTP/HTTPS/WS/WSS traffic must use exactly that proxy or fail. Proxy outage,
authentication failure, GeoIP/WebRTC failure, event-page restart and full Firefox
restart must never select Direct or Off. `storage.local` contains the durable
desired route; losing `storage.session` can lose credentials but cannot lose the
proxy requirement. Corrupt or unreadable durable routing state blocks ordinary
network requests. A proxy becoming unavailable changes health, not route.

1. Proxy credentials never enter page context.
2. Credentials are never persisted in `storage.local`/`storage.sync`.
3. Credentials are never logged; use `describeError()` (it redacts auth schemes).
4. GeoIP providers receive no credentials, cookies or referrers (`credentials: "omit"`,
   `referrerPolicy: "no-referrer"`, `cache: "no-store"`).
5. Page/bridge traffic carries only the public identity payload
   `{ ns, generation, latitude, longitude, accuracy, timezone }` plus the envelope
   flags `pending` and `controlled`. `controlled` means a profile is active, or
   startup has not finished; pages must not call native geolocation in that state.
6. Every inbound message and every stored value is validated with a parser
   (`Result<T>`), never cast.
7. Provider responses are untrusted: `parseIpWhoIsResponse` validates each field.
8. Only this extension may talk to the background (`sender.id` check).
9. `webRequest.onAuthRequired` answers only when `isProxy` is true and the challenger
   host **and** port both match the active HTTP/HTTPS proxy. A missing field or a
   second challenge for the same request id fails closed.
10. `docs/SECURITY.md` is the authoritative list — update it with any change here.
11. Firefox appends its existing proxy as a fallback when `proxy.onRequest` returns
    one `ProxyInfo`. A selected proxy must return `[selectedProxy, null]` so failure
    cannot fall through to Firefox/system routing. Do not remove the terminal null.

Storage layout:

| Key                      | Area              | Contents                                                                                                   |
| ------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `ni.state.v1`            | `storage.local`   | profiles + selected/applied route. **Never** a username or password. Schema version 4 (migrates v1/v2/v3). |
| `ni.cred.v1.<profileId>` | `storage.session` | `{ username, password }`. Cleared when Firefox exits.                                                      |
| `ni.active-target.v1`    | `storage.session` | active target snapshot incl. credentials (needed for cold-start routing).                                  |

Durable profile documents are migrated by `src/profile/migrate.ts`. Versions 1, 2 and 3 are released shapes; current main migrates all three to version 4. A password key found in that document is removed and not written
back. A higher `schemaVersion`, or a version-1 profile that cannot be parsed without
dropping the profile or its proxy, is left byte-for-byte in storage. Startup then blocks ordinary network traffic and reports `schema_unsupported` instead of activating a direct connection. Session
snapshots are not copied into `storage.local`. Bump `SCHEMA_VERSION` and add a migration
step before changing the stored shape.

## 7. Data collection

`browser_specific_settings.gecko.data_collection_permissions` is declared as
`required: ["locationInfo", "authenticationInfo"]` and `optional: ["personallyIdentifyingInfo"]`:

- Automatic and manual activation can query a third-party GeoIP provider (ipwho.is)
  for the observed egress IP. A proxied profile shows the proxy's address. A direct
  profile shows the user's own public IP and does not make that request until optional
  `personallyIdentifyingInfo` is granted.
- Installation does not create or activate a profile, so a fresh install makes no
  GeoIP request.
- The unreleased options picker starts with a bundled local grid and no map requests.
  **Load online map** explicitly enables OpenFreeMap data and remembers the automatic-loading choice.
  MapLibre code, CSS and the CSP worker are packaged locally. A bounded background
  broker validates provider URLs, optional direct-IP consent, owner and route generation.
  Route changes cancel map work before changing routing. Provider-host bypasses refuse
  loading rather than bypassing the selected proxy. See `docs/TILE-POLICY.md`.
- The pinned MapLibre vendor and worker remain covered by every no-eval/remote-code
  build scan and the normal strict extension lint. There is no vendor DOM-warning
  exemption. Re-review upstream bytes, worker hardening and licences before updating
  the pin. Keep attribution authored as text; do not enable raw provider HTML or external
  worker/RTL plugins. See `scripts/vendor/README.md`.
- **Do not change this to `["none"]`** while any automatic provider exists. If you add
  providers, re-review the declaration, `docs/SECURITY.md`, the README and
  `tests/manifest.test.ts` (which pins this behaviour).

## 8. Commands

```bash
npm install          # Node.js >= 22 required (web-ext 10)
npm run build        # dist/ with source maps (development)
npm run build:prod   # minified, no source maps
npm run dev          # build + web-ext run (add -- --firefox="<path>" to pick a build)
npm run check        # format + eslint + tsc + tests + build + web-ext lint
npm run test         # vitest
npm run package      # artifacts/<name>-<version>.zip + package verification
npm run e2e          # real-Firefox smoke test (needs Firefox + network)
npm run e2e:invariants  # local Firefox checks: fail-closed geo, Date, frames, WebRTC
npm run e2e:fail-closed # local SOCKS outage, zero direct-origin requests, event-page restart
npm run e2e:restart     # retained-profile full Firefox restart with SOCKS unavailable
npm run e2e:socks-auth  # session credential loss and recovery without direct fallback
npm run e2e:flap        # repeated SOCKS outage/recovery, no replay or identity reset
npm run icons        # regenerate public/icons deterministically
```

Build output: `dist/` (loadable via `web-ext run` or `about:debugging`).
Package output: `artifacts/`.

## 9. Testing requirements

- Unit tests must not require a browser or the network. All Firefox dependencies are
  injected and replaced by in-memory fakes in `tests/helpers.ts`.
- Anything crossing a boundary gets a parser test **and** a rejection test.
- The MAIN-world shims are tested against Node's real `Date`/`Intl`
  (`tests/timezone-shim.test.ts`), which is why they take the realm as a parameter.
- Keep `tests/manifest.test.ts` honest: it pins MV3, the event page, permissions, the
  version floor and the data-collection declaration.
- Every change that affects behaviour needs a test that fails without the change.
- Firefox-only behaviour is covered by `npm run e2e:invariants`, `e2e:websocket`,
  `e2e:proxy-auth`, `e2e:ui`, `e2e:fail-closed`, `e2e:restart`, `e2e:socks-auth` and `e2e:flap`.
  Those run in the real-Firefox CI gate (`docs/CI.md`), which
  is required on `main`. `npm run e2e` (the smoke test) needs the public GeoIP
  provider, so it stays out of CI and out of `npm run check`.

## 10. Adding a GeoIP provider

1. Implement `GeoIpProvider` in `src/geo/<name>.ts`.
2. Write a strict `parse<Name>Response(value: unknown): Result<GeoIpResult>` — validate
   every field, ignore nothing silently, never trust types.
3. Use `AbortController` + an explicit timeout; set `credentials: "omit"`,
   `referrerPolicy: "no-referrer"`, `cache: "no-store"`.
4. Register it in `createDefaultGeoIpProvider()` (or make it selectable — see
   `docs/ROADMAP.md`).
5. If the provider needs a new host, add it to `host_permissions`.
6. Re-check the data-collection declaration (§7) and document the new third party in
   `docs/SECURITY.md` and the README.

## 11. MAIN-world ↔ isolated-world communication

- Channel constants: `BRIDGE_SOURCE` ("net-identity/bridge") and `PAGE_SOURCE`
  ("net-identity/page") in `src/shared/constants.ts`.
- The page shim announces itself, retries a bounded number of times
  (`CONTENT_ANNOUNCE_DELAYS_MS`) and also listens for pushes, so both orderings work.
- The bridge accepts only two page messages: `hello` and `applied`. It **never** takes
  identity data from the page; `applied` is an untrusted diagnostic used only for
  staleness detection.
- `event.source !== window` must always be checked.
- Content scripts run in every frame (`all_frames: true`, `match_about_blank: true`)
  so a subframe cannot observe the host timezone or geolocation. A sandboxed frame
  that Firefox refuses to inject into remains a platform limit.
- Page `applied` reports are diagnostics only. The background stores them per tab and
  frame, using the sender's tab and frame ids, and the audit is current only when
  every retained frame matches. One current tab does not hide a stale frame.

## 12. Files that must stay small and stable

- `src/shared/result.ts`, `src/shared/constants.ts`, `src/shared/public-identity.ts`
  (the page contract), `src/types/firefox-proxy.d.ts` (only `ProxyInfo`; delete it once
  `@types/firefox-webext-browser` provides the type).
- `src/background/index.ts` — wiring only; business logic belongs in the modules.

## 13. Known limitations

- A sandboxed frame Firefox will not inject into can still see the host timezone and
  geolocation.
- IPv6 CIDR entries are not supported in bypass lists (IPv4 CIDR is).
- GeoIP coordinates are approximate (default accuracy 20 km) and are never presented as
  precise.
- Timezone patching is a page-level compatibility shim, not a process-level change, and
  is observable by sophisticated scripts.
- Challenge-based HTTP proxy authentication depends on Firefox reporting a matching
  `challenger`; preemptive `proxyAuthorizationHeader` is the primary path.
- Page-level geolocation cannot be verified without a custom profile (see
  `docs/MANUAL-TESTING.md`).

## 14. Definition of Done

A change is done when **all** of these hold:

1. `npm run check` passes locally and in CI.
2. New behaviour has tests that fail without it; parsers reject malformed input.
3. No secrets in storage, logs, tests or fixtures.
4. `docs/SECURITY.md`, `docs/ARCHITECTURE.md` and this file are updated when the change
   affects them.
5. Manifest changes keep the Firefox-only, MV3-event-page, minimum-permission posture.
6. The PR is squash-merged through CI — **never** pushed directly to `main`.

## 15. Pull request workflow

```bash
git switch -c feat/short-description
# ... work ...
npm run check
git commit -m "feat: ..."
git push -u origin HEAD
gh pr create --fill          # or with a full body
```

`package.json` `version` is the version that ships. `public/manifest.json` `version`
must be the same value (`npm run check:version` and the build both reject a
mismatch). A release tag must be `v` plus that version, for example `v0.2.0`.
Do not tag a dirty tree, a version that was already published, or an older
version. The extension id stays `net-identity@jacek4yang.github.io`. Release
notes list the supplied pull-request titles and do not add changes that were
not in that list.

`main` is protected: pull requests only, linear history, conversation resolution,
0 required approvals, admins included, no force pushes, no deletions. CI (`quality` and `firefox / invariants`)
provides required checks. Merge with `gh pr merge --squash --delete-branch`.

## Post-v1 profile configuration (schema 4)

The durable `ni.state.v1` document now has `schemaVersion: 4`. The key stays stable
so version-1, version-2 and version-3 documents migrate in place. Migration validates every profile, preserves
routing and explicit WebRTC choices, strips secret keys and leaves unsupported or
unsafe documents unchanged. The reserved `builtin-direct` route is projected in the
domain/UI and is never a persisted user profile. Existing legitimate built-in Direct
records are removed during migration; a reserved record with a proxy is held as unsafe.

Identity policies are independent: GeoIP automatic/disabled with provider id `ipwho.is`,
geolocation follow/manual/disabled (position unavailable, never native), timezone
follow/manual, and WebRTC automatic/manual. Automatic WebRTC uses the route recommendation.
Expert overrides are preserved. Follow-timezone uses the provider's resolved timezone;
manual coordinates alone do not imply a locally inferred timezone.

Save increments the configuration revision and does not alter runtime. The durable applied route is stored separately from the saved profile, without credentials, so a full Firefox restart cannot activate an unapplied edit. An older active user Direct profile with ambiguous applied routing is blocked until the user selects a route again. Apply activates
the saved revision without saving or discarding unsaved form edits. An interrupted Apply resumes its snapshot configuration, never a newer saved revision. Runtime and the session snapshot retain the applied revision and
configuration; Refresh uses that applied configuration, including its session credentials.
Both credential fields start blank. Leaving both blank retains saved session credentials; entering either replaces the pair. Clear changes the saved session credentials;
Apply removes them from a currently active target. Duplicate does not copy usernames or passwords.
Deleting an active profile deactivates it. Off releases WebRTC and synthetic identity.
Direct switches without optional GeoIP permission; without consent it commits an empty,
controlled identity. Firefox/system routing still applies. No lookup occurs merely
because Direct exists. No version or release tag is changed by this overhaul.

## Firefox distribution pipeline

New tags use a two-phase release: the immutable release-config.json selects listed or
unlisted AMO submission, which creates only a draft. Historical v1.1.0 stays listed.
Finalization checks both channels independently; publication requires a public AMO file
(and public listing approval for listed releases), AMO hash/payload checks
and permanent signature-enforcing normal Firefox installation. The primary asset is the
unchanged Mozilla-signed XPI. AMO API v5 credentials are restricted to trusted tag/main
workflows, never PRs. Preserve immutable v1.0.0, v1.1.0 and all historical assets/submissions. The API's
is_mozilla_signed_extension field denotes an internal Mozilla certificate, not ordinary
AMO signing. See docs/RELEASING.md for provenance, rerun and failure rules.

Unlisted AMO file downloads authenticate only the initial request to the AMO file endpoint;
redirects and CDN requests never receive credentials. Finalization tools come from trusted
main and operate in a separate checkout of the unchanged release tag.

## Current schema-4 and health work

Do not reintroduce usernames into `ProxyConfig` or any durable saved/applied profile.
Only `authenticationRequired` is persisted. v3 migrations must preserve the explicit
applied snapshot; do not reconstruct it from newer saved edits. Both credential form
fields load blank. Blank Save keeps the pair; either entered field replaces it; Clear
removes the saved pair/marker; Apply changes runtime. See the upgrade tests in `migrate.test.ts`.

`proxy-health.ts` is passive bounded SOCKS4/SOCKS5/HTTP/HTTPS evidence: matching request ID, generation,
endpoint and hostname; five-second failure window; three 300 ms buckets across at least
two hostnames for suspicion; three non-cached successes across one second for recovery.
Do not call generic errors proof of a proxy outage. Keep the 512-request/30-second bound,
the single shared cooldown timer, 128 waiting decisions and 2-second ceiling. Overflow
still uses the selected route. Never replay HTTP, probe the public network, change route
or clear identity for a health transition. Keep `failoverTimeout: 1`; it is Gecko retry
suppression, not a connection deadline. Preserve Promise and terminal-null semantics.

Store screenshots may come from a clean unsigned candidate when their provenance says
so. They must show actual extension UI with fixture-only data, never fabricated approval
badges. Screenshot preparation is separate from AMO signing/publication gates.

### Authentication data consent

The schema-4 candidate declares `authenticationInfo` for existing usernames/passwords
sent to the user-selected proxy, alongside required `locationInfo`; optional
`personallyIdentifyingInfo` remains the gate for direct GeoIP lookup. This declaration
correction adds no new collection or API capability. Required-data consent can change
install/update prompts. See [Mozilla's taxonomy](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).

## Missing required session credentials

Treat `appliedProxy.authenticationRequired && activeCredentials === null` as a hard
`onBeforeRequest` cancellation condition for non-bypassed ordinary extension-observable
webpage and GeoIP traffic. A terminal
proxy list alone is insufficient: the selected endpoint might accept anonymous access
with a different identity. Do not rely on upstream auth rejection or a warning badge.
Use the applied flag, preserve explicit bypasses, and restore only matching applied
session snapshots. Full exit loses the pair but not the durable requirement. Save does
not unblock/change the active route; Apply commits the replacement pair. Keep the
anonymous-capable SOCKS regression so future changes cannot weaken this boundary.

Do not expand this guarantee to Firefox-protected system-principal requests: they may
reach the same selected proxy through `proxy.onRequest` without being cancellable by
webRequest. Firefox 158 Remote Settings exposed this boundary. Browser-wide account
identity requires server-side rejection of anonymous access. Keep browser-service
attempts recorded/rejected in the local fixture; assert zero ordinary-fixture CONNECTs
and origin hits, not zero global handshakes. Preserve the pre-fix negative control.
Do not add Direct fallback, OS/native changes or perfect-kill-switch claims.

## Candidate quick-add flow

The popup quick-add editor delegates to existing `profiles:save` and explicit
`profiles:activate`. Keep Save non-activating. The bounded endpoint parser refuses
credential URIs without reflecting their text, and new credentials use session-only
fields. Duplicate endpoints can represent different accounts/policies; do not reject
all endpoint duplicates. See `docs/UX-2.0.md` for remaining localization and release work.

## New proxy protection defaults

New proxy profiles now explicitly select `proxy_only` WebRTC, automatic identity,
and proxy DNS for SOCKS4/SOCKS5. The options editor starts with SOCKS5 and DNS enabled,
matching quick setup. Strict WebRTC can prevent calls without a TURN-over-TCP path
through the proxy; it is not a claim that all browser traffic is covered. HTTP/HTTPS
have no equivalent Firefox `proxyDNS` toggle. Explicit bypasses remain visible.

This is a creation default, not a migration. Saved manual policies, DNS choices and
the existing automatic recommendation remain unchanged. Built-in browser/system
routing and Off retain their existing semantics. No new permission or network probe
is introduced. Save still does not apply these settings.

## Remembered visible-map loading (unreleased candidate)

The owner requested automatic viewport loading. The first map enablement remains explicit
and disclosed. Successful explicit authorization remembers only a boolean
`ni.map.autoload.v1`; no viewed coordinates, credentials or routing state are stored there.
After that choice, opening the identity map automatically creates a fresh generation-bound
session. Panning/zooming uses the renderer's existing viewport requests and bounded broker.
No bulk/offline map download or new provider is introduced.

An automatic opening can only reuse an existing direct-IP grant; it never raises a
permission prompt. Missing consent, blocked routing, missing credentials, provider bypasses
and stale generations still fail closed. Closing the panel or changing editor destroys
the old renderer/session. Unload or unchecking automatic loading clears the remembered
choice and stops the current map. No hidden retry loop runs after an error.

Publication remains blocked until the owner accepts the updated final pages.

### Firefox settings audit and passive recovery

Readable system/manual/PAC Firefox settings are informational when an explicit proxy is active;
the terminal-null route still applies to non-bypassed ordinary web requests. Explicit bypasses
retain Firefox routing semantics. Unknown reads, policy control and other extension control
remain warnings. Do not turn those into success or modify Firefox settings to clear a badge.
Passive successes restore route health only after sustained matching non-cached requests.
No request replay, direct fallback, or new public probe is introduced; HTTP health observation
does not introduce SOCKS-specific cooldown scheduling. A recovery diagnostic is not an error.
