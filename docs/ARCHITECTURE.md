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
2. **Durable routing barrier** — `ActivationController.decideProxyForRequest()` returns
   the in-memory decision synchronously when available. Otherwise a single-flight
   local-storage read resolves the committed profile before the request proceeds. A
   valid session snapshot supplies the applied revision and credentials, but an empty
   session area still yields the durable proxy configuration. No GeoIP or WebRTC work
   is on this path. Unsafe or unreadable durable state is canceled by a blocking
   `webRequest.onBeforeRequest` listener.

For a proxied decision, `proxy.onRequest` returns `[selectedProxy, null]`.
Firefox appends its own proxy settings as failover to a single proxy result;
the terminal null prevents an unavailable profile from falling through to
Firefox/system routing. A one-second failover timeout makes failure visible
quickly. The local Firefox harness sets the system proxy to a recording endpoint
and verifies zero fallback requests during SOCKS outage and restart.

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
reads it. Versions 1 and 2 migrate to schema 3 in place: unknown keys are dropped, and `password`,
`credentials` and `proxyPassword` are never copied into the result. The same function is
idempotent. A newer integer `schemaVersion` is not opened and not replaced. A version-1
document that fails validation, repeats an id, or exceeds the profile limit is not
replaced either, so a missing proxy host cannot be saved back as `direct`. In those held
cases the background blocks traffic and publishes `schema_unsupported`. The session snapshot
stays in `storage.session` and is not migrated into the local document.

## Options location map

`location-map.ts` supplies Web Mercator maths. `map-model.ts` owns viewport center,
zoom, selected location and pointer interaction separately. Dragging the background
only pans. A click below the six-CSS-pixel movement threshold selects in manual mode;
marker drag moves the selected point. Once a gesture crosses the threshold, returning
to the start never turns it into a click. Cancellation, lost capture, blur and profile
switches clear the gesture. Automatic preview still permits panning and zoom.

Wheel zoom keeps the point under the pointer fixed. Typed coordinates and Use GeoIP
Location explicitly recenter. A separate observed GeoIP seed prevents manual overrides
from replacing the original lookup result. Resize uses CSS pixels, independent of DPR.
Coordinates accept the full geographic range; only the viewport projection clamps at
the Mercator latitude limit. No imagery is required for any interaction.

`tile-provider.ts` ships `NO_TILES`, a local grid with visible attribution. No map
requests leave the page, no external scripts/styles are loaded, and no Referer is
spoofed. A future image provider must pass policy/privacy review. The image renderer
has bounded negative caching with exponential backoff (30 seconds to 5 minutes), and
requests only visible tiles. See `docs/TILE-POLICY.md`.

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

## Post-v1 profile configuration (schema 3)

Diagnostic and error composition takes identity only from the current routing
generation. An error during teardown cannot attach the previous coordinates to an
empty route or release native geolocation before a successful idle commit.

The durable `ni.state.v1` document now has `schemaVersion: 3`. The key stays stable
so version-1 and version-2 documents migrate in place. The applied route is recorded
separately from mutable saved profiles, without credentials; cold routing uses it before
GeoIP or UI startup. An ambiguous older active user Direct profile is blocked until an
explicit route selection. Migration validates every profile, preserves
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
