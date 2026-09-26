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
scripts can capture the natives. Wrappers are installed immediately but delegate to the
native implementation while no identity is active, so an idle extension is invisible.

Timezones are computed per instant with `Intl.DateTimeFormat` (never a fixed offset), so
DST and historical rule changes are correct. Numeric fields and display names come from
two separate formatters — asking one formatter for both `month: "2-digit"` and
`month: "short"` produced `NaN` offsets and was caught by the test suite.

Geolocation positions are built from the real prototype with own enumerable properties,
so `instanceof GeolocationPosition`, property access and `JSON.stringify` behave as pages
expect. This is verified in real Firefox by `npm run e2e`.

## Known architectural limitations

- Subframes are not patched (`all_frames: false`).
- `navigator.permissions.query` is not patched; a page can still observe the permission
  state, though not the real coordinates.
- Only one identity is active at a time; there is no per-tab identity.
- The provider interface is intentionally narrow (IP + location + timezone) so replacing
  it cannot ripple through the activation logic.
