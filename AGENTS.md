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
- **No runtime dependencies.** Dev tooling only (see `package.json`).
- **No frameworks.** UI is plain HTML/CSS/TypeScript, no React/Vue/Svelte/Redux, no
  WXT/Plasmo/Webpack/Babel.
- **No remote code, no telemetry, no `eval`/`new Function`.** The build script fails
  if `eval`/`new Function` appears in the background bundle.
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

| Path                              | Responsibility                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/background/index.ts`         | **The only file that touches `browser.*` in the background.** Wiring + listeners.                       |
| `src/background/identity.ts`      | `ActivationController`: the activation lifecycle, generation tokens, audit composition.                 |
| `src/background/proxy.ts`         | Pure proxy engine: `ProxyInfo` mapping, bypass matching, auth decisions, Firefox proxy-settings reader. |
| `src/background/credentials.ts`   | Session-only credential store (`storage.session`).                                                      |
| `src/background/active-target.ts` | Session snapshot of the active target (survives event-page suspension).                                 |
| `src/background/webrtc.ts`        | `privacy.network.webRTCIPHandlingPolicy` controller (respects `levelOfControl`).                        |
| `src/background/messages.ts`      | Message router: sender checks, validation, profile CRUD.                                                |
| `src/content/bridge.ts`           | Isolated-world bridge between the background and the page.                                              |
| `src/content/page-shim.ts`        | MAIN-world orchestrator (installs shims, applies identity).                                             |
| `src/content/timezone-shim.ts`    | Date/Intl patching.                                                                                     |
| `src/content/geolocation-shim.ts` | `navigator.geolocation` patching.                                                                       |
| `src/profile/`                    | Profile model, validation (the only place profile rules live), storage.                                 |
| `src/geo/`                        | GeoIP provider interface + the `ipwho.is` implementation.                                               |
| `src/shared/`                     | Result type, primitives, timezone maths, public identity contract, state types, audit, DOM helpers.     |
| `src/options/form.ts`             | Pure form → profile mapping (unit tested; keeps the DOM layer thin).                                    |
| `src/options/location-map.ts`     | Local Web Mercator maths; map-model.ts owns interactions; tile-provider.ts ships no-network grid.       |

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
   `storage.session`; `decideProxyForRequest` falls back to that snapshot instead of
   answering `direct`. Never make the in-memory target the only source of truth. A
   completed restore that finds no usable snapshot is remembered, so later requests
   do not read `storage.session` again until activation or deactivation.
6. **`proxy.onRequest` may return a Promise.** The cold-start fallback depends on it.
7. **`content_scripts[].world: "MAIN"` requires Firefox 128+**. The manifest floor is
   **140.0** because that is when Firefox shows built-in data-collection consent.
8. **`data_collection_permissions` is enforced by the 140 floor.** Required
   `locationInfo` is accepted at install. Optional `personallyIdentifyingInfo` is
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

## 6. Security invariants (do not weaken)

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

Storage layout:

| Key                      | Area              | Contents                                                                            |
| ------------------------ | ----------------- | ----------------------------------------------------------------------------------- |
| `ni.state.v1`            | `storage.local`   | profiles + `activeProfileId`. **Never** a password. Schema version 2 (migrates v1). |
| `ni.cred.v1.<profileId>` | `storage.session` | `{ username, password }`. Cleared when Firefox exits.                               |
| `ni.active-target.v1`    | `storage.session` | active target snapshot incl. credentials (needed for cold-start routing).           |

Durable profile documents are migrated by `src/profile/migrate.ts`. Version 1 is the only released shape; current main migrates it to version 2. A password key found in that document is removed and not written
back. A higher `schemaVersion`, or a version-1 profile that cannot be parsed without
dropping the profile or its proxy, is left byte-for-byte in storage. Startup then stays
idle and reports `schema_unsupported` instead of activating a direct connection. Session
snapshots are not copied into `storage.local`. Bump `SCHEMA_VERSION` and add a migration
step before changing the stored shape.

## 7. Data collection

`browser_specific_settings.gecko.data_collection_permissions` is declared as
`required: ["locationInfo"]` and `optional: ["personallyIdentifyingInfo"]`:

- Automatic and manual activation can query a third-party GeoIP provider (ipwho.is)
  for the observed egress IP. A proxied profile shows the proxy's address. A direct
  profile shows the user's own public IP and does not make that request until optional
  `personallyIdentifyingInfo` is granted.
- Installation does not create or activate a profile, so a fresh install makes no
  GeoIP request.
- The options location picker uses a bundled local grid and makes no tile requests.
  `src/options/tile-provider.ts` defines the image-only provider contract. See
  `docs/TILE-POLICY.md`; review policy and privacy before enabling any network provider.
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
- Firefox-only behaviour is covered by `npm run e2e:invariants`, `e2e:websocket` and
  `e2e:proxy-auth`. Those three run in the real-Firefox CI gate (`docs/CI.md`), which
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
0 required approvals, admins included, no force pushes, no deletions. CI (`quality`)
is a required check. Merge with `gh pr merge --squash --delete-branch`.

## Post-v1 profile configuration (schema 2)

The durable `ni.state.v1` document now has `schemaVersion: 2`. The key stays stable
so version-1 documents migrate in place. Migration validates every profile, preserves
routing and explicit WebRTC choices, strips secret keys and leaves unsupported or
unsafe documents unchanged. The reserved `builtin-direct` route is projected in the
domain/UI and is never a persisted user profile. Existing legitimate built-in Direct
records are removed during migration; a reserved record with a proxy is held as unsafe.

Identity policies are independent: GeoIP automatic/disabled with provider id `ipwho.is`,
geolocation follow/manual/disabled (position unavailable, never native), timezone
follow/manual, and WebRTC automatic/manual. Automatic WebRTC uses the route recommendation.
Expert overrides are preserved. Follow-timezone uses the provider's resolved timezone;
manual coordinates alone do not imply a locally inferred timezone.

Save increments the configuration revision and does not alter runtime. Apply activates
the saved revision without saving or discarding unsaved form edits. An interrupted Apply resumes its snapshot configuration, never a newer saved revision. Runtime and the session snapshot retain the applied revision and
configuration; Refresh uses that applied configuration, including its session credentials.
Blank passwords retain saved credentials. Clear changes the saved session credentials;
Apply removes them from a currently active target. Duplicate does not copy passwords.
Deleting an active profile deactivates it. Off releases WebRTC and synthetic identity.
Direct switches without optional GeoIP permission; without consent it commits an empty,
controlled identity. Firefox/system routing still applies. No lookup occurs merely
because Direct exists. No version or release tag is changed by this overhaul.
