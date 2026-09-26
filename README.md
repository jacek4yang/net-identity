# net-identity

A Firefox network identity manager that keeps **proxy, public IP, geolocation, timezone
and WebRTC behaviour consistent**.

**Firefox only.** There is no Chrome/Edge/Safari support and no cross-browser
abstraction layer: the extension uses Firefox's native `browser.*` APIs (`proxy.onRequest`,
`privacy.network.webRTCIPHandlingPolicy`, `webRequest.onAuthRequired`, `world: "MAIN"`
content scripts) precisely because those APIs allow a correct implementation.

- Licence: MIT
- Minimum Firefox: **128.0** (desktop)
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
   reports a _proxy_ challenge (`isProxy`) and the challenger matches the active proxy.
6. The extension never rewrites Firefox's global proxy settings, so `about:preferences`
   stays under your control and everything is reversible.

See [`docs/SECURITY.md`](docs/SECURITY.md) for the invariants and
[`SECURITY.md`](SECURITY.md) for reporting a vulnerability.

## Privacy considerations

- **Automatic profiles contact a third-party GeoIP provider** (`ipwho.is`) over HTTPS.
  The request is sent from the active proxy egress, so that provider sees the proxy's
  public IP — and, if your profile is a _direct_ one, your own. The request sends no
  credentials, no cookies and no referrer, and the response is never cached. Manual and
  direct profiles that you do not refresh make no such request.
- This is declared to AMO as required `locationInfo` collection, with
  `personallyIdentifyingInfo` as optional; see
  [`docs/SECURITY.md`](docs/SECURITY.md#data-collection-declaration).
- GeoIP coordinates are **approximate**. They are published with a coarse accuracy
  (20 km by default) and are never dressed up as GPS precision.
- The timezone and geolocation shims are **compatibility shims, observable by
  sophisticated page scripts**. They are not a claim of fingerprinting invisibility, and
  `navigator.permissions.query` is not patched.
- No telemetry, no analytics, no remote JavaScript.

## Requirements

- Firefox 128 or newer (desktop). Firefox Developer Edition is recommended for
  development.
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

The Windows path is never hard-coded in project logic — pass it when you need it. For an
automated real-browser check (extension install, identity resolution, page-visible
timezone and geolocation):

```bash
npm run e2e
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

## Geolocation behaviour

- A `document_start`, `MAIN`-world content script overrides
  `navigator.geolocation.getCurrentPosition`, `watchPosition` and `clearWatch`.
- While no identity is active, every call is delegated to the native implementation, so
  the extension is invisible when idle.
- While an identity is being resolved, requests are held briefly (2 s) rather than
  leaking the real position.
- Returned positions are real `GeolocationPosition` prototype instances with own
  `coords`/`timestamp` properties, and are accurate to the coarse accuracy you set.
- Known gaps: subframes are not patched and `navigator.permissions.query` is untouched.

## Timezone behaviour

- Offsets are computed per instant from the IANA timezone, so **DST and historical rule
  changes are handled** — never as a fixed UTC offset.
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
- Deactivating a profile restores Firefox's `default` policy.

## Development

```bash
npm install         # Node.js >= 22
npm run build       # dist/ (dev, with source maps)
npm run check       # prettier --check, eslint, tsc, vitest, build, web-ext lint
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

- `npm run test` – 215 unit tests: profile validation, proxy mapping and auth decisions,
  bypass matching, GeoIP parsing and failure handling, timezone maths, DST transitions,
  real `Date`/`Intl` shim behaviour, activation atomicity and stale-response handling,
  credential separation, message-router authorisation, the manifest contract.
- `npm run check` – adds ESLint (type-aware), `tsc --noEmit`, a production-shaped build,
  and `web-ext lint` where _every_ error and any unexpected warning fails the build.
- `npm run package` – builds and then inspects the zip: required entries present, and no
  tests, sources, source maps or config files inside.
- `npm run e2e` – launches real Firefox, activates the default profile, and asserts what
  a page observes (shim installed, timezone and offset matching the resolved identity,
  geolocation coordinates matching the provider with the coarse accuracy).

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

- Firefox desktop only, 128+.
- Shims apply to the top frame only.
- `navigator.permissions.query({ name: "geolocation" })` is unpatched.
- Bypass lists do not support IPv6 CIDR ranges.
- GeoIP accuracy is coarse by design (20 km default).
- Challenge-based HTTP proxy authentication depends on Firefox reporting a matching
  `challenger`; preemptive authentication is the primary path.
- Timezone/geolocation patching is page-visible to determined scripts.
- The data-collection declaration must be re-reviewed whenever a provider is added.

## Roadmap

Short version (details in [`docs/ROADMAP.md`](docs/ROADMAP.md)):

1. Optional identically-typed host permissions / per-provider configuration UI.
2. Patch `navigator.permissions.query` and support subframes.
3. Package/export profiles without secrets, plus import.
4. Per-profile GeoIP provider selection with an enumeration of allowed endpoints.

## License

[MIT](LICENSE).
