# Architecture

## Contexts

Firefox Manifest V3 extensions run in several isolated contexts. net-identity uses four:

| Context                   | File                           | Can use `browser.*`          | Visible to the page |
| ------------------------- | ------------------------------ | ---------------------------- | ------------------- |
| Background event page     | `src/background/index.ts`      | yes (with permissions)       | no                  |
| Isolated content script   | `src/content/bridge.ts`        | yes (runtime/tabs messaging) | no                  |
| MAIN-world content script | `src/content/page-shim.ts`     | no                           | yes, by design      |
| UI pages (popup, options) | `src/popup/*`, `src/options/*` | yes (runtime messaging)      | no                  |

Data flow for an identity update:

```
GeoIP provider ──▶ ActivationController ──▶ PublicIdentity
                              │                    │
                              │              broadcastIdentity()
                              ▼                    ▼
                     RuntimeState         content/bridge.js (isolated)
                              │                    │ window.postMessage
                              ▼                    ▼
                     popup / options      content/page-shim.js (MAIN)
                                                   │
                                      Date/Intl + navigator.geolocation
```

## Why a background _event page_

Firefox MV3 does not use Chrome-style service workers for extensions. The manifest
declares `background.scripts` with `type: "module"`, which Firefox runs as a
non-persistent event page that can be suspended while the browser stays open.

That has one serious consequence for a proxy manager: if the in-memory routing target
disappeared on suspension, the next `proxy.onRequest` would have to answer something —
answering `{ type: "direct" }` would quietly send traffic outside the proxy.

Two mechanisms prevent that:

1. **Session snapshot** (`src/background/active-target.ts`) — after routing changes, the
   active target (including the session password) is written to `storage.session`. It is
   written _before_ the network lookup so a crash or suspension mid-activation is safe.
2. **Async fallback** — `ActivationController.decideProxyForRequest()` returns the
   in-memory decision synchronously when it can, and otherwise returns a Promise that
   first restores the snapshot. Firefox explicitly allows `proxy.onRequest` to return a
   Promise, which is what makes this possible.

`storage.session` is cleared when Firefox exits, so a fresh browser session always
performs a full activation and re-resolves the identity from the observed egress IP.

## Activation lifecycle

`ActivationController.activate(profileId)` implements the whole transition described in
the README. The important properties:

- **Generation tokens.** Each activation increments a counter; a resolution that
  completes after a newer activation started is discarded. The previous lookup is also
  aborted through an `AbortController`.
- **Observed, not assumed.** The identity always comes from the GeoIP provider's answer
  for the current egress, never from the proxy hostname or a configured label.
- **Audit after every step.** `buildAuditReport()` recomputes the audit from the current
  state, so the popup can never show a stale "consistent" verdict.
- **Never throws.** Failures become an `error` status plus a precise `lastError` and
  audit entry, because a thrown error in the background script would leave the UI
  showing nothing at all.
- **WebRTC is relinquished, not overwritten.** `deactivate()` calls
  `privacy.network.webRTCIPHandlingPolicy.clear()`. Firefox then exposes the value that
  was effective before this extension took control. A clear or read failure is reported
  and does not pretend the policy returned to `default`.

## Layering and testability

The Firefox API surface is injected everywhere:

- `index.ts` is the only background file that touches `browser.*`.
- `src/profile/`, `src/geo/`, `src/shared/` and the pure parts of `src/content/` are
  plain TypeScript that runs in Node, which is why 200+ unit tests need no browser.
- The content shims receive their realm (`Date`, `Intl`, constructors) as parameters, so
  `tests/timezone-shim.test.ts` exercises the real patch behaviour against Node's real
  implementations.

Parsers (`Result<T>`) are used at every trust boundary instead of type assertions:

| Input                        | Parser                                          |
| ---------------------------- | ----------------------------------------------- |
| Stored profile state         | `parseProfileState` → `parseProfile`            |
| Session credentials          | `parseCredentials`                              |
| Active target snapshot       | `parseActiveTargetSnapshot`                     |
| Inbound runtime messages     | `parseInboundMessage`                           |
| Runtime state sent to the UI | `parseRuntimeState`                             |
| Identity payload for pages   | `parsePublicIdentity` / `parseIdentityEnvelope` |
| GeoIP provider responses     | `parseIpWhoIsResponse`                          |

## Proxy engine

`buildProxyInfo()` maps a profile onto Firefox's `ProxyInfo`:

| Profile type | `ProxyInfo`                                | Credentials                         | Notes                                          |
| ------------ | ------------------------------------------ | ----------------------------------- | ---------------------------------------------- |
| `direct`     | `{ type: "direct" }`                       | —                                   | does not override Firefox's own proxy settings |
| `http`       | `{ type: "http", host, port }`             | `proxyAuthorizationHeader: Basic …` | preemptive; `407` handled by `onAuthRequired`  |
| `https`      | `{ type: "https", host, port }`            | same as `http`                      |                                                |
| `socks5`     | `{ type: "socks", host, port, proxyDNS }`  | `username`/`password`               | SOCKS authentication                           |
| `socks4`     | `{ type: "socks4", host, port, proxyDNS }` | not possible in Firefox             | the UI states this                             |

SOCKS4 has no authentication support at all, and `proxyDNS` is only honoured for
`socks4`/`socks`. Those are Firefox limitations, surfaced in the UI rather than hidden.

Bypass matching (`bypassEntryMatchesHost`) supports bare hosts (matching subdomains, as
Firefox's own exclusion list does), `*.domain`, IP literals and IPv4 CIDR. Loopback is
always bypassed; the GeoIP endpoint never is, because it must observe the proxy egress.

`parseRequestUrl()` accepts `http`, `https`, `ws` and `wss`. Those four schemes share
the bypass list and the active `ProxyInfo`. `moz-extension`, `about`, `file`, `data`,
`blob`, `ftp` and any unparsable URL stay `{ type: "direct" }`, so the extension does
not intercept internal browser URLs. The `proxy.onRequest` filter remains `<all_urls>`
because that match pattern already includes WebSocket URLs.

## Page shims

`page-shim.ts` runs at `document_start` in the MAIN world so it installs before page
scripts can capture the natives. The geolocation wrapper starts fail-closed. It calls
Firefox's implementation only after an envelope with `controlled: false` says no profile
is active. A pending envelope keeps the previous synthetic position; a committed profile
without coordinates returns position-unavailable instead of the host location.

Timezones are computed per instant with `Intl.DateTimeFormat` (never a fixed offset), so
DST and historical rule changes are correct. Local `Date` getters and setters use that
same wall clock. UTC methods are not patched. A spring-forward gap uses the
post-transition offset and a fall-back fold uses the earlier instant. Numeric fields and
display names come from two separate formatters — asking one formatter for both
`month: "2-digit"` and `month: "short"` produced `NaN` offsets and was caught by the
test suite.

Geolocation positions are built from the real prototype with own enumerable properties,
so `instanceof GeolocationPosition`, property access and `JSON.stringify` behave as pages
expect. This is verified in real Firefox by `npm run e2e`.

## Profile schema migration

`ni.state.v1` in `storage.local` is the only durable profile document. `src/profile/migrate.ts`
reads it. Version 1 is canonicalised in place: unknown keys are dropped, and `password`,
`credentials` and `proxyPassword` are never copied into the result. The same function is
idempotent. A newer integer `schemaVersion` is not opened and not replaced. A version-1
document that fails validation, repeats an id, or exceeds the profile limit is not
replaced either, so a missing proxy host cannot be saved back as `direct`. In those held
cases the background stays idle and publishes `schema_unsupported`. The session snapshot
stays in `storage.session` and is not migrated into the local document.

## Options location map

Manual coordinates are still a profile field. The options page projects them with a
local Web Mercator implementation in `src/options/location-map.ts`. Automatic mode
previews the resolved identity; Manual mode keeps the centre pin and the latitude and
longitude inputs on the same point (click, drag, or typing). The circle is the accuracy
value pages will receive. Zoom is chosen so a coarse accuracy stays visible, and the
zoom buttons pin an explicit level.

Raster tiles are optional `<img>` requests to `tile.openstreetmap.org`, sent only while
the options page is showing the map, with no referrer. Indexes that fall outside the
zoom are omitted. The CSS grid under the images is the offline surface, so coordinate
entry does not depend on the tile host. No script is loaded from that host.

## Setting changes after activation

`browser.proxy.settings.onChange` and `privacy.network.webRTCIPHandlingPolicy.onChange`
re-read those settings and broadcast the audit. The handlers do not call `set` or
`clear`, and a WebRTC event whose value and `levelOfControl` already match the
published state is ignored, so this extension's own write does not loop. The profile
is not activated again and its generation does not change.

## Page-shim diagnostics

Each content-script report is stored by tab id and frame id. Those ids come from
Firefox's message sender, not from the page. The page payload stays a diagnostic
(generation, timezone, whether the geolocation shim is active) and is never copied
into the identity. The audit is current only when every retained frame matches.
The active tab is called out in the summary and does not override a stale frame.
Closed tabs are removed. The log keeps at most 64 frames.

## Known architectural limitations

- Subframes are patched (`all_frames: true`, `match_about_blank: true`). While
  geolocation is controlled, `navigator.permissions.query({ name: "geolocation" })`
  resolves to `granted`; other names and idle mode use the native query. A sandboxed
  document Firefox will not inject into is unchanged.
- Only one identity is active at a time; there is no per-tab identity.
- The provider interface is intentionally narrow (IP + location + timezone) so replacing
  it cannot ripple through the activation logic.
