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
- Minimum Firefox is **128.0** (the floor at which `content_scripts[].world = "MAIN"`
  exists). Do not add a `strict_max_version`.
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
   answering `direct`. Never make the in-memory target the only source of truth.
6. **`proxy.onRequest` may return a Promise.** The cold-start fallback depends on it.
7. **`content_scripts[].world: "MAIN"` requires Firefox 128+**, hence
   `strict_min_version: "128.0"`.
8. **`data_collection_permissions` requires Firefox 140+**; older versions ignore the
   key. It is declared because AMO requires it and because automatic profiles do contact
   a third-party GeoIP provider (see §7). web-ext lint warns about the version gap; the
   allowance is recorded in `scripts/lint-extension.mjs`.

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
- `deactivate()` clears routing, restores the WebRTC `default` policy, clears the
  snapshot and publishes `payload: null` so pages revert to native behaviour.

## 6. Security invariants (do not weaken)

1. Proxy credentials never enter page context.
2. Credentials are never persisted in `storage.local`/`storage.sync`.
3. Credentials are never logged; use `describeError()` (it redacts auth schemes).
4. GeoIP providers receive no credentials, cookies or referrers (`credentials: "omit"`,
   `referrerPolicy: "no-referrer"`, `cache: "no-store"`).
5. Page/bridge traffic carries only `{ ns, generation, latitude, longitude, accuracy,
timezone }`.
6. Every inbound message and every stored value is validated with a parser
   (`Result<T>`), never cast.
7. Provider responses are untrusted: `parseIpWhoIsResponse` validates each field.
8. Only this extension may talk to the background (`sender.id` check).
9. `webRequest.onAuthRequired` answers only when `isProxy` is true _and_ the challenger
   matches the active proxy (host or port).
10. `docs/SECURITY.md` is the authoritative list — update it with any change here.

Storage layout:

| Key                      | Area              | Contents                                                                  |
| ------------------------ | ----------------- | ------------------------------------------------------------------------- |
| `ni.state.v1`            | `storage.local`   | profiles + `activeProfileId`. **Never** a password.                       |
| `ni.cred.v1.<profileId>` | `storage.session` | `{ username, password }`. Cleared when Firefox exits.                     |
| `ni.active-target.v1`    | `storage.session` | active target snapshot incl. credentials (needed for cold-start routing). |

## 7. Data collection

`browser_specific_settings.gecko.data_collection_permissions` is declared as
`required: ["locationInfo"]` and `optional: ["personallyIdentifyingInfo"]`:

- Automatic identity mode queries a third-party GeoIP provider (ipwho.is) from the
  active egress, so location data is collected and the provider learns the egress IP.
- With a _proxied_ profile that IP is the proxy's; with a _direct_ profile it is the
  user's own, hence the optional PII entry.
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
- Content scripts run in the top frame only (`all_frames: false`) — subframes are a
  known limitation, not a bug to fix silently.

## 12. Files that must stay small and stable

- `src/shared/result.ts`, `src/shared/constants.ts`, `src/shared/public-identity.ts`
  (the page contract), `src/types/firefox-proxy.d.ts` (only `ProxyInfo`; delete it once
  `@types/firefox-webext-browser` provides the type).
- `src/background/index.ts` — wiring only; business logic belongs in the modules.

## 13. Known limitations

- Top frame only; no shim in subframes.
- `navigator.permissions.query({ name: "geolocation" })` is not patched.
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

`main` is protected: pull requests only, linear history, conversation resolution,
0 required approvals, admins included, no force pushes, no deletions. CI (`quality`)
is a required check. Merge with `gh pr merge --squash --delete-branch`.
