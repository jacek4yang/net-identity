# net-identity

A Firefox network identity manager that keeps **proxy, public IP, geolocation, timezone
and WebRTC behaviour consistent**.

**Firefox only.** There is no Chrome/Edge/Safari support and no cross-browser
abstraction layer: the extension uses Firefox's native `browser.*` APIs (`proxy.onRequest`,
`privacy.network.webRTCIPHandlingPolicy`, `webRequest.onAuthRequired`, `world: "MAIN"`
content scripts) precisely because those APIs allow a correct implementation.

- Licence: MIT
- Minimum Firefox: **140.0** (desktop)
- Node.js for development: **>= 22** (required by `web-ext` 10)
- No runtime dependencies, no telemetry, no remote code

## Why it exists

Renting a proxy is easy; keeping a browser consistent with it is not. A proxy alone
usually still leaks:

| Leak                                                | What net-identity does                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| DNS resolved outside the proxy                      | `proxyDNS` for SOCKS, so names are resolved by the proxy                       |
| WebRTC exposing the real interface/IP               | applies a WebRTC IP handling policy when the profile activates                 |
| `navigator.geolocation` returning the real position | returns the identity's approximate coordinates at `document_start`             |
| `Date`/`Intl` reporting the wrong timezone          | patches page-visible timezone reads, DST-aware                                 |
| The IP you _think_ you have ≠ the IP sites see      | resolves the identity from the **observed egress IP** through the active proxy |
| A "direct" profile silently not being direct        | reports Firefox's own proxy configuration in the audit                         |

## Features

- **Profiles** binding proxy + identity + WebRTC policy into one switchable unit
  (create, edit, duplicate, delete, activate).
- **Proxy support** for `direct`, `http`, `https`, `socks4` and `socks5`, with bypass
  lists (hosts, `*.domain`, IP literals, IPv4 CIDR) and loopback always bypassed.
- **Proxy authentication** without ever putting a password in durable storage:
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

1. Proxy passwords live **only** in `browser.storage.session` and vanish when Firefox
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
- This is declared to AMO as required `locationInfo` collection, with
  `personallyIdentifyingInfo` as optional; see
  [`docs/SECURITY.md`](docs/SECURITY.md#data-collection-declaration).
- GeoIP coordinates are **approximate**. They are published with a coarse accuracy
  (20 km by default) and are never dressed up as GPS precision.
- The timezone and geolocation shims are **compatibility shims, observable by
  sophisticated page scripts**. They are not a claim of fingerprinting invisibility, and
  `navigator.permissions.query` is not patched.
- The options page can load map images from `tile.openstreetmap.org` while it is open.
  The tile address reveals the area on screen. Images are requested with no referrer.
  No proxy credentials or profile secrets are attached. The map still accepts typed
  coordinates when those images cannot load. No telemetry, no analytics, no remote
  JavaScript.

## Requirements

- Firefox 140 or newer (desktop). Firefox Developer Edition is recommended for
  development. 140 is the floor for Firefox's built-in data-collection consent.
- Node.js 22 or newer and npm (for building and testing).

## Installation

### From a packaged build

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
7. **Activate** it. The popup shows the resulting identity, the audit and the state of
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
- While no profile is active, calls are delegated to the native implementation, so an
  idle extension is invisible.
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
- New proxy profiles default to `disable_non_proxied_udp`; `proxy_only` is available as
  the strictest option; WebRTC is never disabled entirely.
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

- `npm run test` – 274 unit tests: profile validation, proxy mapping and auth decisions,
  bypass matching, GeoIP parsing and failure handling, timezone maths, DST transitions,
  real `Date`/`Intl` shim behaviour, activation atomicity and stale-response handling,
  credential separation, message-router authorisation, the manifest contract, the
  manual location map (projection, seeding, tile URLs), profile schema migration, and
  per-frame page-shim diagnostics, and audit updates after external proxy or WebRTC
  setting changes.
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
  proxy and checks that a correct password is accepted without a 407 loop, and a wrong
  password is challenged only a bounded number of times.

CI runs two jobs on every pull request and every push to `main`: the fast `quality`
job and a real-Firefox `firefox` job. The `firefox` job runs the deterministic
`e2e:invariants` and `e2e:websocket` harnesses against a loopback page and proxies, so
it never contacts the public GeoIP provider. It is the browser gate for a release; see
[`docs/CI.md`](docs/CI.md) for the one-time branch-protection setting that makes it a
required check. `npm run e2e` and `npm run e2e:proxy-auth` need the public provider or
a settled profile, so they stay local and release-candidate smoke checks (#21).

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
