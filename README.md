# Net Identity

A Firefox network identity manager that keeps **proxy, public IP, geolocation, timezone
and WebRTC behaviour consistent**.

[Install for Firefox](https://addons.mozilla.org/en-US/firefox/addon/net-identity/) ·
[简体中文](README.zh-CN.md) · [Quick setup and migration](docs/QUICKSTART.md) ·
[Support](https://github.com/jacek4yang/net-identity/issues)

You supply the proxy; Net Identity does not sell proxy access or provide a VPN service.

**Candidate branch:** popup quick setup, search, bilingual UI and stricter new-profile
protection are in development and are not yet public AMO features. Existing releases
remain immutable. See [the candidate interaction record](docs/UX-2.0.md).

**Firefox only.** There is no Chrome/Edge/Safari support and no cross-browser
abstraction layer: the extension uses Firefox's native `browser.*` APIs (`proxy.onRequest`,
`privacy.network.webRTCIPHandlingPolicy`, `webRequest.onAuthRequired`, `world: "MAIN"`
content scripts) precisely because those APIs allow a correct implementation.

- Licence: MIT
- Minimum Firefox: **140.0** (desktop)
- Node.js for development: **>= 22** (required by `web-ext` 10)
- Locally bundled MapLibre renderer; no telemetry or remote executable code

**1.1.5 is released:** opt-in OpenFreeMap basemaps are available with locally bundled
MapLibre, readable CJK labels and an offline coordinate fallback. Mozilla approved the
listed version on 2026-10-01; its unchanged signed XPI passed permanent installation in
normal Firefox. The failed 1.1.4 attempt remains immutable. See [release history](docs/RELEASING.md).

## Why it exists

A proxy changes the network route, but page-visible identity and browser policy need
separate attention. The extension addresses these distinct concerns:

| Leak                                                | What net-identity does                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| DNS resolved outside the proxy                      | `proxyDNS` for SOCKS, so names are resolved by the proxy                       |
| WebRTC exposing the real interface/IP               | applies a WebRTC IP handling policy when the profile activates                 |
| `navigator.geolocation` returning the real position | returns the identity's approximate coordinates at `document_start`             |
| `Date`/`Intl` reporting the wrong timezone          | patches page-visible timezone reads, DST-aware                                 |
| The IP you _think_ you have ≠ the IP sites see      | resolves the identity from the **observed egress IP** through the active proxy |
| A "direct" profile silently not being direct        | reports Firefox's own proxy configuration in the audit                         |

## Features

- **One-click routes:** Off, built-in Direct and user profiles in a compact popup.
  Direct uses Firefox/system routing; Off releases synthetic identity and WebRTC control.
  Direct needs no setup or GeoIP consent to switch routing.
- **Save / Apply:** Save stores edits without changing runtime. Saved changes remain
  pending until Apply. Refresh keeps the applied configuration.
- **Independent identity policies:** GeoIP automatic/disabled, geolocation follow/manual/
  unavailable, timezone follow/manual, and WebRTC automatic or an explicit Firefox policy.

- **Profiles** binding proxy + identity + WebRTC policy into one switchable unit
  (create, edit, duplicate, delete, activate).
- **Proxy support** for `direct`, `http`, `https`, `socks4` and `socks5`, with bypass
  lists (hosts, `*.domain`, IP literals, IPv4 CIDR) and loopback always bypassed.
- **Proxy authentication** with session-only usernames and passwords:
  session-only credentials, preemptive Basic for HTTP/HTTPS, strict challenge matching
  for proxies that demand `407`.
- **Automatic identity**: the public egress IP is observed through the active proxy and
  the derived country/region/city/timezone/coordinates are applied everywhere.
- **Manual identity**: pin coordinates, accuracy and timezone yourself.
- **Identity audit**: per-aspect status using precise terms — _consistent_,
  _not configured_, _unavailable_, _manual_, _provider error_, _controlled by another
  extension_, _stale_ — never vague privacy claims.
- **Live consistency check**: open pages report which identity generation they applied,
  so a failed or stale injection is visible instead of assumed.

## Architecture overview

```
popup / options (plain HTML+TS)          background (MV3 event page)
        │  runtime.sendMessage                   │
        └───────────────▶ message router ◀────────┘
                             │
                  ActivationController
   proxy routing ─ WebRTC policy ─ identity resolution ─ broadcast
                             │
        ┌────────────────────┴─────────────────────┐
        ▼                                          ▼
content/bridge.js (isolated world)         browser.proxy.onRequest
        │  window.postMessage                 privacy.network.*
        ▼
content/page-shim.js (MAIN world)
  timezone shim + geolocation shim
```

Full details, including why each Firefox API is used the way it is, are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`AGENTS.md`](AGENTS.md).

## Security model

1. Proxy usernames and passwords live **only** in `browser.storage.session` and vanish when Firefox
   exits. They are never written to `storage.local`, never included in a profile, never
   logged, and never sent to a content script, page or GeoIP provider.
2. Only this extension can talk to the background script (`sender.id` check), and every
   message and stored value is validated by a parser before use.
3. The MAIN-world channel carries exactly one shape of data:
   `{ ns, generation, latitude, longitude, accuracy, timezone }`.
4. Provider responses are untrusted input and are validated field by field.
5. Proxy credentials are answered to `webRequest.onAuthRequired` only when Firefox
   reports a _proxy_ challenge (`isProxy`) whose host and port both match the active
   proxy, and only once per request.
6. The extension never rewrites Firefox's global proxy settings, so `about:preferences`
   stays under your control and everything is reversible.

See [`docs/SECURITY.md`](docs/SECURITY.md) for the invariants and
[`SECURITY.md`](SECURITY.md) for reporting a vulnerability.

## Privacy considerations

- **Activating or refreshing a profile can contact a third-party GeoIP provider**
  (`ipwho.is`) over HTTPS. A proxied profile shows that provider the proxy's public IP.
  A direct profile shows it your own public IP, and that lookup waits until you allow
  optional personal-data collection. The request sends no credentials, no cookies and
  no referrer, and the response is never cached. Installing the extension does not
  create or activate a profile, so a fresh install makes no such request.
- This is declared to AMO as required `locationInfo` and `authenticationInfo` collection, with
  `personallyIdentifyingInfo` as optional; see
  [`docs/SECURITY.md`](docs/SECURITY.md#data-collection-declaration).
- GeoIP coordinates are **approximate**. They are published with a coarse accuracy
  (20 km by default) and are never dressed up as GPS precision.
- The timezone and geolocation shims are **compatibility shims, observable by
  sophisticated page scripts**. They are not a claim of fingerprinting invisibility, and
  controlled geolocation reports a synthetic permission status.
- The options location picker starts with a local grid and makes **no automatic map
  requests**. The **Load online map** action adds OpenFreeMap geographic
  imagery beneath the existing selection controls. MapLibre code, CSS and its worker
  are bundled locally. Manual coordinate entry and the grid remain available offline.
- Online map requests reveal the viewed region and network-visible IP to OpenFreeMap
  and its delivery infrastructure. Direct/browser routing additionally requires the
  optional personal-data grant. Proxy failures do not enable a Direct fallback;
  route changes cancel the map session and require a new explicit enable action.
  See [tile policy and attribution](docs/TILE-POLICY.md) and [privacy](docs/PRIVACY.md).

## Requirements

- Firefox 140 or newer (desktop). Firefox Developer Edition is recommended for
  development. 140 is the floor for Firefox's built-in data-collection consent.
- Node.js 22 or newer and npm (for building and testing).

## Installation

For normal Firefox, install from the public
[AMO listing](https://addons.mozilla.org/en-US/firefox/addon/net-identity/).
Version **1.1.5** is public on AMO and uses Firefox's default AMO update channel.
Its [signed installer, source, checksums and provenance](https://github.com/jacek4yang/net-identity/releases/tag/v1.1.5)
were published on 2026-10-01 after Mozilla approval and permanent signed-install
verification in normal Firefox 157. The public description and privacy policy were
updated along with all four screenshots. [Independent public verification](store-assets/publication-v1.1.5.json)
confirmed the copy, captions, image order and pixel-identical full-size screenshots.
Historical 1.1.3 listing evidence is preserved in [its dated record](store-assets/publication-v1.1.3.json).

Versions 1.1.1 and 1.1.2 remain historical unlisted self-distribution releases; their
submissions and assets are unchanged. For a verified signed GitHub installer, download
`net-identity-<version>-firefox-signed.xpi` and use Add-ons and themes → gear →
Install Add-on From File. Source, checksums and provenance accompany the installer.
GitHub itself does not automatically update installations. No custom update URL is
configured; a higher listed AMO version may update them through Firefox's default
AMO update service, subject to approval and any required consent prompts.

See [reviewer notes](docs/AMO-REVIEW.md), [release checklist](docs/RELEASE-CHECKLIST.md),
[privacy policy](docs/PRIVACY.md), and [release process](docs/RELEASING.md).
The historical v1.0.0 ZIP is not the signed installer and remains unchanged.

### From a packaged build, for development

```bash
npm install
npm run package
# artifacts/net-identity-<version>.zip
```

Install the zip via `about:addons` → gear icon → _Install Add-on From File…_
(unsigned builds require Firefox Developer Edition, Nightly or ESR with signature
checks disabled).

### From source, temporarily

```bash
npm install
npm run dev
```

`npm run dev` builds `dist/` and launches `web-ext run`. To target a specific build:

```bash
npm run dev -- --firefox="/path/to/firefox"
```

## Firefox Developer Edition development workflow

```bash
npm install                     # once
npm run build                   # dist/ (development build with source maps)
npm run dev                     # web-ext run against dist/
npm run check                   # what CI runs
npm run package                 # artifacts/<name>-<version>.zip
```

On Windows with Firefox Developer Edition in its default location:

```powershell
npm run dev -- --firefox="C:\Program Files\Firefox Developer Edition\firefox.exe"
```

The Windows path is never hard-coded in project logic — pass it when you need it. For
automated real-browser checks (extension install, identity resolution, page-visible
timezone and geolocation, and WebSocket proxy routing):

```bash
npm run e2e
npm run e2e:websocket
```

## Creating a profile

1. Open the extension's **Manage Profiles** page.
2. **New profile** → name it.
3. Pick the proxy type and fill in host/port (or choose `direct`).
4. Optionally set a proxy username/password. _Stored only for the current Firefox
   session._
5. Choose the identity mode:
   - **Automatic** – the proxy's observed egress identity is resolved and applied.
   - **Manual** – enter latitude, longitude, accuracy and an IANA timezone.
6. Pick a WebRTC policy and **Save**.
7. Click **Save**, then **Apply**, or click the saved profile row in the popup. The popup shows the resulting identity, the audit and the state of
   open pages.

## Proxy support

| Type            | Notes                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `direct`        | No proxying. Beware: this does **not** override a proxy configured in Firefox's own settings — the audit reports that case as _not configured_. |
| `http`, `https` | Optional credentials, sent as a preemptive `Proxy-Authorization` header and, if the proxy answers `407`, through strict challenge matching.     |
| `socks5`        | Optional username/password (SOCKS authentication). `Proxy DNS` defaults to on, so names are resolved by the proxy.                              |
| `socks4`        | No authentication (a Firefox limitation — the UI says so) and `proxyDNS` is honoured.                                                           |

Bypass lists accept bare hosts, `*.domain`, IP literals and IPv4 CIDR ranges.
`localhost`, `127.0.0.1` and `::1` are always bypassed. The GeoIP endpoint is
deliberately **not** bypassed: it must observe the proxy egress.

`http`, `https`, `ws` and `wss` all use that decision, so a page cannot leave an active
proxy by opening a WebSocket. Other schemes (`about:`, `file:`, extension pages, `data:`)
stay direct.

## Geolocation behaviour

- A `document_start`, `MAIN`-world content script overrides
  `navigator.geolocation.getCurrentPosition`, `watchPosition` and `clearWatch`.
- Once Off has successfully committed, calls are delegated to the native implementation.
  The compatibility shim remains detectable; this is not an invisibility guarantee.
- While a profile is active, pending, or still starting, the shim does not call
  Firefox's geolocation API. A previous synthetic position is kept until the new
  identity is committed. If none is available, the page gets a timeout or
  position-unavailable error instead of the host location.
- Returned positions are real `GeolocationPosition` prototype instances with own
  `coords`/`timestamp` properties, and are accurate to the coarse accuracy you set.
- `navigator.permissions.query({ name: "geolocation" })` returns `granted` while a
  profile is controlling geolocation, and the native result when the extension is idle.
- The same shims run in subframes, including `about:blank` and `about:srcdoc`.

## Timezone behaviour

- Offsets are computed per instant from the IANA timezone, so **DST and historical rule
  changes are handled** — never as a fixed UTC offset.
- `Date` local getters (`getFullYear`, `getMonth`, `getDate`, `getDay`, `getHours`,
  `getMinutes`, `getSeconds`) and the matching setters use the identity's wall clock.
  UTC methods are unchanged. Setter overflow follows `Date.UTC`. A spring-forward gap
  uses the post-transition offset; a fall-back fold uses the earlier instant.
- `Date.prototype.getTimezoneOffset/toString/toTimeString/toDateString/toLocale*` and
  `Intl.DateTimeFormat` (including `resolvedOptions().timeZone`) report the identity's
  timezone unless the caller explicitly passed one.
- This is a page-level compatibility shim, **not** a change to Firefox's process
  timezone. `about:config`, other tabs and the browser UI are unaffected.

## WebRTC behaviour

- Applies `privacy.network.webRTCIPHandlingPolicy` on activation, after checking
  `levelOfControl`.
- On this candidate branch, new proxies select strict `proxy_only`. Previously saved
  automatic/manual choices remain unchanged. Strict mode can prevent calls without
  TURN over TCP through the proxy; it does not disable the entire WebRTC API.
- If another extension or an enterprise policy controls the setting, the UI says
  _controlled by another extension_ instead of pretending it succeeded.
- Deactivating a profile calls `BrowserSetting.clear()`, so Firefox restores the
  WebRTC policy that was effective before this extension took control. It does not
  write `default` over that value.

## Development

```bash
npm install         # Node.js >= 22
npm run build       # dist/ (dev, with source maps)
npm run check       # prettier --check, eslint, tsc, vitest, build, web-ext lint, version check
npm run test:watch  # vitest in watch mode
npm run lint:fix    # eslint --fix
npm run icons       # regenerate public/icons (deterministic)
```

Layout:

```
src/background/   event page: activation, proxy engine, credentials, WebRTC, router
src/content/      isolated bridge + MAIN-world page shims
src/geo/          GeoIP provider interface and the ipwho.is implementation
src/profile/      profile model, validation, storage
src/popup/        popup UI
src/options/      profile management UI
src/shared/       shared types, parsers, timezone maths, DOM helpers
public/           manifest.json + icons
scripts/          build, packaging, lint wrapper, dev proxy, E2E smoke test
tests/            vitest unit tests (no browser required)
```

## Testing

- `npm run test` – browser-free unit tests: profile validation, proxy mapping and auth decisions,
  bypass matching, GeoIP parsing and failure handling, timezone maths, DST transitions,
  real `Date`/`Intl` shim behaviour, activation atomicity and stale-response handling,
  session-only credential separation, bounded SOCKS health and cooldown, message-router authorisation, the manifest contract, the
  offline location map (projection, seeding and interaction), profile schema migration,
  per-frame page-shim diagnostics, audit updates after external proxy or WebRTC setting
  changes, the AMO reviewer metadata, the real-Firefox CI gate, the AMO submission
  workflow, and the GitHub Release metadata and checksums.
- `npm run check` – adds ESLint (type-aware), `tsc --noEmit`, a production-shaped build,
  and `web-ext lint` where _every_ error and any unexpected warning fails the build.
- `npm run package` – builds and then inspects the zip: required entries present, and no
  tests, sources, source maps or config files inside.
- `npm run e2e` – launches real Firefox, activates an HTTP profile through a local
  forwarding proxy, and asserts what a page observes (shim installed, timezone and
  offset matching the resolved identity, geolocation coordinates matching the provider
  with the coarse accuracy).
- `npm run e2e:websocket` – launches real Firefox with a local HTTP proxy profile and
  asserts that `ws`/`wss` reach that proxy while a loopback WebSocket stays bypassed.
- `npm run e2e:invariants` – launches real Firefox with a local page, a rejecting
  proxy and a sentinel native geolocation provider. It checks that a failed
  automatic identity does not reveal that sentinel, that manual coordinates and
  `Date` getters follow the profile, that child frames see the same timezone, and
  that deactivation restores the previous WebRTC policy and the native position.
- `npm run e2e:proxy-auth` – launches real Firefox against the bundled authenticating
  local CONNECT fixture and checks that a correct password is accepted without a 407
  loop, and a wrong password is challenged only a bounded number of times. No public
  provider or upstream service is contacted.
- `npm run e2e:ui` – checks the real popup, profile Save/Apply and offline map interactions.
- `npm run e2e:map-fallback` – checks explicitly disabled WebGL, editable fallback,
  map-broker consent, route-generation cancellation and blocked unbrokered requests.
- `LIBGL_ALWAYS_SOFTWARE=1 xvfb-run -a npm run e2e:map -- --firefox /path/to/firefox`
  – requires real WebGL rendering: local vector geometry, raster/sprite data, packaged
  worker, CSP, map interactions and screenshot pixel assertions. No silent render skip.
  Run `npm run build:prod` first (development source maps are rejected).
  Both map modes serve the production provider origin through a local HTTPS fixture;
  its short-lived CA is trusted only in a disposable test Firefox profile, which is
  removed afterwards. System and normal-user trust stores are not changed.
- `npm run e2e:fail-closed` – checks SOCKS outage and event-page recovery with zero direct
  or system-proxy fallback for HTTP, HTTPS, WS, WSS and proxy DNS.
- `npm run e2e:restart` – checks retained-profile full Firefox restart while SOCKS is down.
- `npm run e2e:socks-auth` – checks session credential loss and recovery through the same
  selected proxy after restart.
- `npm run e2e:flap` – checks three SOCKS outage/recovery cycles, burst failures, stable
  identity/generation, no failed-request replay and zero fallback sentinel hits.

CI requires `quality` and `firefox / invariants`. Its ten deterministic loopback browser gates
cover invariants, WebSockets, proxy authentication, UI, fail-closed outages, full
restart, credential loss, `e2e:flap` (three SOCKS outage/recovery cycles), online-map
rendering and map fallback/privacy. Version 1.1.5 passed these gates on its exact merged
commit, including three immediate map Reload cycles; adding a harness alone is not a test result.
They do not require public GeoIP or map providers. Only `npm run e2e`, the optional public
provider smoke test, stays outside CI. See [CI details](docs/CI.md).

Manual proxy verification (including `407` authentication) uses the bundled test proxy:

```bash
node scripts/dev-proxy.mjs --port 8080 --require-auth user:pass
```

See [`docs/MANUAL-TESTING.md`](docs/MANUAL-TESTING.md).

## Building and packaging

- `npm run build` → `dist/` (development, source maps)
- `npm run build:prod` → `dist/` (minified, no source maps)
- `npm run package` → `artifacts/net-identity-<version>.zip`, verified to contain only
  runtime files

The build fails fast if the manifest references a file that was not emitted, so a
misconfigured manifest cannot produce a silently broken extension.

## Known limitations

**Firefox-protected browser traffic:** the missing-credential gate cancels ordinary
extension-observable webpage and GeoIP requests, but Firefox does not allow extensions
to cancel all browser-service requests. On Firefox 158, protected Remote Settings traffic
could still attempt anonymous access to the same selected proxy after credentials were
lost. This does not add Direct fallback; a server accepting anonymous access can still
assign a different egress identity. For the same account identity across all browser
traffic, the proxy server must reject anonymous clients. This extension is not a
browser-wide kill switch. See [the documented boundary](docs/SECURITY.md#missing-required-credentials-and-the-firefox-cancellation-boundary).

- Firefox desktop only, 140+.
- A sandboxed frame that Firefox will not inject a content script into can still see
  the host timezone and geolocation.
- Bypass lists do not support IPv6 CIDR ranges.
- GeoIP accuracy is coarse by design (20 km default).
- Challenge-based HTTP proxy authentication depends on Firefox reporting a matching
  `challenger`; preemptive authentication is the primary path.
- Timezone/geolocation patching is page-visible to determined scripts.
- The data-collection declaration must be re-reviewed whenever a provider is added.

## Roadmap

Short version (details in [`docs/ROADMAP.md`](docs/ROADMAP.md)):

1. Optional identically-typed host permissions / per-provider configuration UI.
2. Selectable GeoIP providers, after the remaining identity-consistency work.
3. Package/export profiles without secrets, plus import.
4. Per-profile GeoIP provider selection with an enumeration of allowed endpoints.

## License

[MIT](LICENSE).

## SOCKS health and recovery

Health is passive evidence, not proof of a proxy outage. Matching request IDs,
route generations and sanitized proxy endpoints prevent unrelated, bypassed, cached
or old requests from changing the current route's diagnosis. Repeated failures across
multiple destinations and time buckets can mark the route suspect; sustained successful
traffic establishes recovery. The selected profile and synthetic identity stay unchanged.

Suspected SOCKS failures can briefly delay new proxy decisions with a bounded cooldown.
The extension never replays failed HTTP requests, changes to Direct, or launches background
health probes. See [the exact bounds and limitations](docs/ARCHITECTURE.md#passive-socks-health).
Schema 4 removes legacy stored usernames; usernames and passwords live only for the
Firefox session. Enter both again when replacing an authenticated pair.

### Authentication data consent

Version 1.1.3 declares `authenticationInfo` for existing usernames/passwords
sent to the user-selected proxy, alongside required `locationInfo`; optional
`personallyIdentifyingInfo` remains the gate for direct GeoIP lookup. This declaration
correction adds no new collection or API capability. Required-data consent can change
install/update prompts. See [Mozilla's taxonomy](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).

### Store asset provenance

[Four real Firefox UI captures](store-assets/README.md#screenshots) accompany the
verified 1.1.5 candidate capture. They use a labeled local demonstration profile with GeoIP disabled and no
credentials. The map capture shows actual OpenFreeMap geography and visible attribution;
[its review](store-assets/screenshots/capture-review.json) verifies the production source
hashes and pixels. These remain unsigned-candidate UI evidence, not signing or listing approval.

## Community and help

[Report a problem](https://github.com/jacek4yang/net-identity/issues), read the
[quick-start guide](docs/QUICKSTART.md), or follow [private vulnerability reporting](SECURITY.md).

Community resource: [LINUX DO](https://linux.do/). This is an independent community
link, not an endorsement, sponsorship, security audit or reciprocal partnership.
