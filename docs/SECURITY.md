# Security model

This document is the authoritative list of security invariants. Any change that weakens
one of them is a breaking change; update this file deliberately, with the tests that
enforce it (`tests/credentials.test.ts`, `tests/messages-router.test.ts`,
`tests/public-identity.test.ts`, `tests/proxy.test.ts`, `tests/activation.test.ts`).

## Invariants

**Fail-closed proxy routing.** When a proxy profile is the committed desired route,
proxy unavailability can reduce availability but must never reduce routing
confidentiality by deliberately falling back to Direct. Extension-observable ordinary
HTTP, HTTPS, WS, and WSS requests use that proxy or fail. Protected Firefox system
requests lie outside the cancellation boundary described below. A missing session snapshot after full Firefox exit does not
remove the durable selection in `storage.local`; the request listener restores the
validated proxy configuration before allowing a request. If durable routing state
cannot be parsed or read safely, `webRequest.onBeforeRequest` cancels ordinary
network requests. Firefox otherwise appends its current system proxy as a
fallback to a single `ProxyInfo`; proxied decisions therefore return a terminal
`[selectedProxy, null]` list. The null entry ends the failover chain. An outage
changes diagnostic health only. In particular:

```
ordinary proxy-bound request + unavailable proxy -> request failure
```

The route changes only after an explicit user action. Proxy usernames and passwords remain
session-only. After a full restart the missing-credential gate cancels ordinary
proxy-bound traffic until credentials are applied. It does not add a Direct fallback,
but protected browser requests require server-side rejection of anonymous access.

1. **Proxy credentials never enter page context.**
   The MAIN world and every `window.postMessage` payload carry exactly
   `{ ns, generation, latitude, longitude, accuracy, timezone }`
   (`createPublicIdentity`), and `serializeForPage` is asserted against a whitelist of
   keys in tests.

2. **Proxy credentials are never persisted in `storage.local`.**
   Usernames and passwords live only under `ni.cred.v1.<profileId>` in `browser.storage.session`
   (`src/background/credentials.ts`), plus inside the session-only active-target
   snapshot. Tests serialise the local area and assert usernames and passwords are absent.

3. **Proxy credentials are never logged.**
   Only `describeError()` output is ever logged, which redacts `Basic …`/`Bearer …`
   tokens and `(proxy-)authorization:`/`password:`/`token:` values. A proxy error
   containing a base64 credential is asserted to come out redacted.

4. **External GeoIP providers receive no explicit credentials.**
   The provider request is a `GET` with `credentials: "omit"`, `referrerPolicy:
"no-referrer"`, `cache: "no-store"` and a single `accept: application/json` header.
   Tests assert the request options.

5. **Content/page communication carries only public identity information.**
   The bridge posts nothing else, and ignores every page message except `hello` and
   `applied`. Page-supplied data is never treated as identity input — `applied` is an
   untrusted diagnostic used only to detect a stale injection. The envelope may also
   carry the booleans `pending` and `controlled`. `controlled` tells the page that
   native geolocation must not be used.

6. **Incoming messages are validated.**
   `runtime.onMessage` rejects senders whose extension id is not ours, then validates the
   payload with `parseInboundMessage`, then validates the profile with `parseProfile`.
   Content-only messages (`content:hello`, `content:report`) are additionally required to
   come from a tab.

7. **External responses are treated as untrusted.**
   Every GeoIP field is validated; malformed optional fields are discarded, a malformed
   required field (`ip`) fails the lookup. Provider text is sanitised of control
   characters and length-capped before it reaches the UI.

8. **No telemetry exists.** There is no analytics, no crash reporting and no update
   ping. Extension-initiated external requests are the disclosed GeoIP lookup and,
   in version 1.1.5, explicitly enabled OpenFreeMap data loads.
   Installing or opening the options page does not enable either service.

9. **No remote JavaScript is loaded.** Everything executable ships in the package; there is no
   `import()` of a remote URL. Script and worker sources remain self-only. Online-map
   data destinations are explicitly allowlisted without relaxing script execution.

10. **No `eval` or dynamic code execution.**
    `scripts/build.mjs` scans every shipped script, including the options vendor and
    worker, and rejects dynamic execution. Pinned upstream source hashes and the exact
    external-plugin loader replacement are checked separately. No vendor-lint warning
    exception is permitted; see `docs/AMO-REVIEW.md`.

## Online-map security boundary (released in 1.1.5)

MapLibre main code, CSS and worker are local package assets. Only approved HTTPS data
paths under `tiles.openfreemap.org` can reach the network through the typed background
broker. A page cannot supply arbitrary URLs, HTTP methods, headers or proxy credentials.
Validated map URLs are serialized once with `URL.href` before both fetch and pending
request correlation, so font-stack spaces match Firefox's encoded request URL. The
network gate still matches the exact authorized resource, never just the provider host.
The map protocol carries public map data, never authentication state. The provider is
not exempted from existing fail-closed or missing-proxy-credential gates.

Map authorization is ephemeral and bound to the trusted options editor and current
routing generation. Route changes invalidate authorization synchronously rather than
waiting for a UI broadcast. Pending fetches are aborted, and the request gate rejects
stale generations after asynchronous checks. Optional permission is rechecked; revocation
or background restart does not silently re-enable the map. Limits on sessions, concurrent
loads, response sizes and deadlines prevent unbounded resource retention. Failed loads
do not replay application requests or modify identity. See implementation tests for
exact bounds and races; these guarantees require the map feature's final release gates.

## Additional protections

- **Origin vs proxy authentication.** `webRequest.onAuthRequired` returns credentials
  only when Firefox reports a proxy challenge (`isProxy === true`), the active profile is
  an HTTP/HTTPS proxy with stored credentials, and the challenger host and port both
  match that proxy. A missing field, a same-port challenge from another host, or a
  repeated `407` for the same request receives no credentials. `WWW-Authenticate`
  challenges from websites can therefore never receive proxy credentials. Preemptive
  `proxyAuthorizationHeader` is unchanged.
- **Geolocation fails closed.** While a profile is active, while activation is in
  flight, and until startup has committed an idle result, the page shim does not call
  `getCurrentPosition` or `watchPosition` on Firefox's implementation. A previous
  synthetic position is kept until the replacement identity is committed. If none is
  available the page receives a timeout or position-unavailable error. Native
  geolocation is used only after a committed idle envelope (`controlled: false`).
  Failed teardown is still controlled: it clears the departed route's identity and
  does not release native geolocation until Off successfully commits.
- **A profile-less state never carries identity.** Publishing coordinates is bound to
  `activeProfileId`. A page cannot receive the previous profile's latitude, longitude
  or timezone after deactivation, and a proxy/WebRTC `onChange` that lands while
  deactivation is releasing the WebRTC setting cannot resurrect them. Deactivation is
  a single transition: setting-change refreshes are ignored until it commits its idle
  state. `tests/activation.test.ts` pins both the state and the envelope.
- **WebSocket egress follows the active proxy.** `ws:` and `wss:` use the same
  `decideProxy()` path as `http:`/`https:`, including the bypass list. While a proxied
  profile is active, a page cannot leave that proxy by opening a WebSocket. Non-network
  schemes stay direct on purpose. `tests/proxy.test.ts` pins the scheme split, and
  `npm run e2e:websocket` checks it in real Firefox.
- **OTHER extensions cannot interfere.** `runtime.onMessage` ignores senders that are not
  this extension, including messages sent to this extension id by another add-on.
- **Reversibility.** The extension never writes Firefox's global proxy settings, so
  removing it (or deactivating a profile) restores the previous browser behaviour. The
  WebRTC policy is relinquished with `BrowserSetting.clear()` on deactivation, so
  Firefox restores the previously effective value instead of being forced to `default`.
- **Honest reporting.** If another extension controls the WebRTC policy, net-identity
  reports _controlled by another extension_ rather than claiming success. If Firefox
  itself has a proxy configured, the audit reports that a `direct` profile does not
  override it.

## Secret handling summary

| Secret                               | Where it lives                                            | Lifetime            | Reaches page context?                            |
| ------------------------------------ | --------------------------------------------------------- | ------------------- | ------------------------------------------------ |
| Proxy password                       | `storage.session` (`ni.cred.v1.*`, `ni.active-target.v1`) | until Firefox exits | never                                            |
| Proxy username                       | `storage.session` (`ni.cred.v1.*`, `ni.active-target.v1`) | until Firefox exits | never                                            |
| GeoIP location data                  | profile in `storage.local`                                | persistent          | only coordinates/accuracy/timezone, deliberately |
| Client certificate, cookies, history | not touched                                               | —                   | —                                                |

There is no key material, no signing, no native messaging and no local server.

If a `password`, `credentials` or `proxyPassword` key is ever found inside
`ni.state.v1`, profile migration drops it and writes the profile back without that
key. A newer schema version is not rewritten, so an upgrade cannot replace a future
document with an empty one or with a direct profile.

## Platform trust boundary

Firefox's `storage.session` is restricted to trusted extension contexts
(`TRUSTED_CONTEXTS`), so content scripts cannot read it. Firefox clears it when the
browser exits, which is also the documented guarantee given to users in the UI
("Stored only for the current Firefox session.").

## Data collection declaration

The manifest declares:

```json
"data_collection_permissions": {
  "required": ["locationInfo", "authenticationInfo"],
  "optional": ["personallyIdentifyingInfo"]
}
```

Reasoning, so a reviewer can verify it:

- Automatic and manual activation can send an HTTPS request to a third-party GeoIP
  provider (`https://ipwho.is/…`) and store the returned location data. That is location
  data collected and transmitted off the device, so `none` would be false.
- Firefox 140+ presents required `locationInfo` and `authenticationInfo` in the install/update consent experience. The extension
  does not run on older Firefox, so there is no second consent UI.
- `personallyIdentifyingInfo` is _optional_ because a **direct** profile sends the
  user's own public IP. A **proxied** profile sends the proxy's address and does not
  need that optional grant. The direct lookup is refused until
  `permissions.request({ data_collection: ["personallyIdentifyingInfo"] })` succeeds.
- A fresh install does not create or activate a profile, so it does not contact the
  provider.
- The location picker begins offline. The online-map action discloses
  OpenFreeMap as an additional recipient of network-visible IP and viewed map area.
  Required `locationInfo` covers that area; Direct/Off requires the existing optional
  personal-data grant. Provider bypasses refuse loading, not silently reroute it.
  No proxy credentials, cookies, referrer, native geolocation or remotely executed
  code are supplied to the map service. See `docs/TILE-POLICY.md`.
- `tests/manifest.test.ts` asserts that the declaration exists, uses only documented
  categories and is not `["none"]` while an automatic provider exists.

If you add another provider, re-review this declaration, this document, the README and
the test. `docs/ROADMAP.md` tracks making the provider selectable so the declaration can
stay accurate per configuration.

## Post-v1 profile configuration (schema 4)

The durable `ni.state.v1` document now has `schemaVersion: 4`. The key stays stable
so version-1, version-2 and version-3 documents migrate in place. The non-secret applied route
is stored separately from the saved profile; Save cannot change full-restart routing.
An older selected user Direct profile whose applied route cannot be proved is blocked
until the user explicitly selects a route again. Migration validates every profile, preserves
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

The signed manifest may omit exactly one final LF byte. The verifier proves this by
reconstructing that single byte in memory and matching the original submission SHA-256;
it does not normalize JSON or allow value changes. All other payload files must remain
byte-identical. Release metadata records both manifest hashes and whether this occurred.
The downloaded signed XPI is never rewritten.

## Schema-4 credential and health regression guards

A legacy username is parsed only to derive `authenticationRequired`; the value never
appears in the new profile. Migration preserves v3 `appliedSelection` independently from
saved edits, including an applied proxy with a newer saved Direct revision. Valid old
session snapshots retain their active credentials during an event-page/upgrade restart.
Unsupported or unsafe durable documents remain unchanged and fail closed; this is not a
claim that arbitrary unknown documents can be scrubbed safely.

Passive SOCKS health accepts only request/generation/endpoint-correlated observations.
`proxyInfo` is configured route metadata, not handshake proof; error strings cannot
prove outage. Destination refusal and rejected SOCKS authentication can share an error.
No raw event object, username, authorization header, path or query is retained. Cancellation,
cache hits, mismatched endpoints and expired requests cannot establish failure/recovery.
The bounded cooldown recomputes routing when released; it never replays HTTP or changes
the selected route. See [architecture](ARCHITECTURE.md#passive-socks-health) and `e2e:flap`.

### Authentication data consent

The schema-4 candidate declares `authenticationInfo` for existing usernames/passwords
sent to the user-selected proxy, alongside required `locationInfo`; optional
`personallyIdentifyingInfo` remains the gate for direct GeoIP lookup. This declaration
correction adds no new collection or API capability. Required-data consent can change
install/update prompts. See [Mozilla's taxonomy](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).

## Missing required credentials and the Firefox cancellation boundary

For an applied proxy with `authenticationRequired: true`, a missing session credential
pair is a blocking condition in `webRequest.onBeforeRequest`, not merely a diagnostic.
The extension cancels non-bypassed ordinary webpage HTTP/HTTPS/WS/WSS and its observable
GeoIP requests before they use the proxy anonymously. The same endpoint might otherwise
accept anonymous access with a different egress identity. A matching session snapshot
restores the applied pair; full browser exit loses it. Save alone does not change the
applied route: the user must Apply replacement credentials. Explicit bypasses and
intentionally unauthenticated profiles retain their existing policy.

**This is not a browser-wide kill switch.** Firefox protects system-principal requests
from webRequest cancellation. Firefox 158 Remote Settings traffic was observed entering
`proxy.onRequest` while bypassing the cancellation listener; it could attempt anonymous
access to the same selected proxy after session credentials were lost. Terminal-null
routing does not introduce Direct fallback, but cannot enforce authentication for those
protected requests. To maintain account identity across all browser traffic, the proxy
server must reject anonymous access. No OS firewall, native helper or browser security
setting is changed by this extension.

Firefox also owns existing connections and its proxy-authentication caches. Applying
a routing policy does not promise to terminate or reconstruct every existing tunnel,
or to perform fresh transport authentication when credentials change at the same proxy
endpoint. Servers should reject anonymous proxy access. The map broker's cancellation
and generation checks protect its own pending requests; they do not claim control over
all Firefox connection lifecycles. The deterministic map fixture closes its bootstrap
tunnels before measuring the extension's authenticated route, so that test does not
establish account isolation for connections created before Apply.

For HTTP/HTTPS proxies, account identity also requires the server to demand
authentication. In a separate ordinary map-request diagnostic, Firefox opened a fresh
CONNECT without preemptive credentials when the fixture accepted anonymous access and
did not issue a 407 challenge. Configured session credentials and a preemptive header
therefore do not prove account authentication at an anonymous-capable endpoint. The
strict authenticated fixture rejects missing/wrong credentials and passes with the
selected pair. This boundary is not limited to protected browser-service requests and
does not imply a Direct fallback: the request still uses the selected proxy endpoint.

[MDN documents protected system requests](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/onAuthRequired#proxy_authorization).
Gecko's [ChannelWrapper](https://raw.githubusercontent.com/mozilla-firefox/firefox/main/toolkit/components/extensions/webrequest/ChannelWrapper.cpp)
separates system modification from proxy matching; [ProxyChannelFilter](https://searchfox.org/firefox-main/source/toolkit/components/extensions/ProxyChannelFilter.sys.mjs)
uses proxy matching. The dual-mode fixture records and locally rejects browser-service
attempts, while asserting zero anonymous fixture CONNECTs and origin hits from ordinary
test traffic. It does not assert zero browser-wide SOCKS handshakes. Removing the gate
must make the ordinary-traffic negative control fail.

## Candidate quick setup

The popup quick-add form uses the existing validated profile save and explicit activation
messages. It never probes an endpoint. Credential-bearing pasted URIs are refused with
fixed text; credentials must use the existing session-only fields. Save never changes
the applied route or initiates identity lookup. While a quick submission is pending its
controls and competing popup route actions are disabled; runtime generations remain
responsible for rejecting stale state. Closing the panel clears credential input fields.
