# Continuous integration and the real-Firefox gate

CI runs two jobs on every pull request and every push to `main`:

| Job       | What it does                                                                  | Typical time   |
| --------- | ----------------------------------------------------------------------------- | -------------- |
| `quality` | Prettier, ESLint, `tsc`, Vitest, a production build, `web-ext lint`, version. | under a minute |
| `firefox` | The deterministic real-Firefox invariants (below).                            | a few minutes  |

`firefox` calls the reusable workflow
[`.github/workflows/firefox-invariants.yml`](../.github/workflows/firefox-invariants.yml).
A separate definition keeps the fast job fast and gives the tag release workflow
(#31) exactly one browser gate to depend on, so a tagged release and a pull request
run the same checks.

## What the Firefox job runs

The job installs stable Firefox and Developer Edition from Mozilla's APT repository.
The existing browser checks run on stable Firefox. Persistent-profile restart checks
run on Developer Edition so the exact unsigned candidate can be preinstalled before
startup; the release finalizer separately verifies the Mozilla-signed XPI in normal
stable Firefox.

The browser job uses `npm run build:prod`, so every deterministic harness exercises
the minified, source-map-free distribution that is packaged for release. Map capture
metadata inspects the build instead of assuming that any `dist/` is a production build.

- `npm run e2e:invariants` – fail-closed controlled geolocation, `Date`/`Intl`
  timezone consistency, supported frames, and WebRTC apply/restore.
- `npm run e2e:websocket` – `ws`/`wss` routing through the active proxy while a
  loopback WebSocket stays bypassed.

Every request goes to a loopback page, proxy or WebSocket server. The harnesses never
contact the public GeoIP provider, so the gate cannot fail because an external service
is slow or down.

`npm run e2e:proxy-auth` now uses an offline authenticated CONNECT fixture. It
checks wrong-password rejection, correct-password acceptance and secret-free logs
without contacting a public provider. It runs in the required Firefox gate alongside
`npm run e2e:ui`, which drives popup routes, Save/Apply and real pointer/wheel map
interactions, including Firefox offline mode. `npm run e2e` remains outside CI because
it requires the public GeoIP provider.

`e2e:fail-closed`, `e2e:restart`, `e2e:socks-auth` and `e2e:flap` use a local SOCKS5 server,
a recording origin and an alternate Firefox system proxy. They assert zero
connections to that origin while the selected SOCKS server is down, including
HTTP/HTTPS/WS/WSS, a synthetic DNS name, event-page teardown and a full browser
restart. The restart harness preinstalls the extension in a retained profile so a
startup navigation races restoration. The auth variant verifies that a lost
session credential pair leaves Proxy A selected and blocked until credentials are entered
again. Recovery uses the same proxy endpoint.

On failure the job uploads `firefox-*.log`. The logs contain loopback ports and the
bundled test proxy's throwaway `user:pass`; no repository secret is used by this job.

The map implementation released in 1.1.5 includes two required checks in the same job:

- `e2e:map-fallback` disables WebGL and checks the editable local-grid fallback,
  explicit map consent and the bounded background gateway's routing/privacy rules.
- `e2e:map` runs with Xvfb and Mesa software rendering. It loads real deterministic
  vector/raster data through the packaged MapLibre worker, checks canvas pixels and
  CSP, exercises repeated editor interactions and partial-load recovery, and saves
  screenshots. Missing WebGL or blank geography fails; a fallback is not a render pass.
  The required run uses a private Latin-only fontconfig and verifies a deterministic
  CJK glyph's strokes/holes plus its exact brokered PBF request. It neither installs
  CJK fonts to hide missing glyphs nor modifies the system font configuration.

Both use an authenticated loopback CONNECT proxy serving the exact production
`tiles.openfreemap.org` HTTPS origin. The harness generates a temporary test CA and
trusts it only in its explicit disposable Firefox profile; `acceptInsecureCerts`
stays false. Public OpenFreeMap is never contacted. Profile, certificates, private
keys and child processes are cleaned up on success or failure, and certificates/keys
are forbidden in the packaged extension. This isolated test trust does not alter the
system trust store or a user's Firefox profile. Logs redact transient extension UUIDs.
CI uploads `firefox-map-render` screenshot evidence on success and includes map
screenshots with its failure logs. This describes the gate, not a recorded pass.

## Required branch protection

Verified through the GitHub API on 2026-09-27: `main` requires both `quality` and
`firefox / invariants`, with strict status checks. Neither job may be bypassed for
these changes. A reusable workflow reports its check as `<caller job> / <called job>`.

The UI harness waits for the toolbar panel to be open with the extension's actual
popup URL, then addresses that remote browser's Marionette actor from chrome.
`openPopup()` resolving does not mean the panel has finished opening. The selected
Options tab is a separate context; the harness restores its saved window handle
and root frame without reloading it. Popup-as-tab checks supplement this panel test.

The auth fixture challenges only the GeoIP CONNECT target. Other Firefox background
requests receive a local 502, so they cannot cause unrelated auth dialogs or upstream
network traffic. The target still exercises wrong and correct credentials unchanged.

## Running the same gate locally

```bash
npm ci
npm run check
npm run build:prod
npm run e2e:invariants -- --firefox "<path to Firefox>"
npm run e2e:websocket -- --firefox "<path to Firefox>"
npm run e2e:proxy-auth -- --firefox "<path to Firefox>"
npm run e2e:ui -- --firefox "<path to Firefox>"
npm run e2e:map-fallback -- --firefox "<path to Firefox>"
env -u MOZ_HEADLESS LIBGL_ALWAYS_SOFTWARE=1 xvfb-run -a npm run e2e:map -- --firefox "<path to Firefox>" --screenshots artifacts/map-render
npm run e2e:fail-closed -- --firefox "<path to Firefox Developer Edition>"
npm run e2e:restart -- --firefox "<path to Firefox Developer Edition>"
npm run e2e:socks-auth -- --firefox "<path to Firefox Developer Edition>"
npm run e2e:flap -- --firefox "<path to Firefox Developer Edition>"
```

A missing Firefox binary exits with code `2` and an `INCONCLUSIVE` message; it is never
reported as a pass.

The Firefox gate also permanently attempts an unsigned fixture installation with normal
Firefox signature enforcement and requires rejection. This tests the release verifier's
negative path; finalization tests the actual AMO-signed file. Release submission and
approval/signature finalization are separate workflows; see [RELEASING.md](RELEASING.md).

## Repeated SOCKS flaps

`npm run e2e:flap` runs the retained-profile Developer Edition harness through three
outage/recovery cycles. It covers HTTP, HTTPS, WS, WSS and synthetic-name proxy DNS,
36-request failure bursts, stable selected route/identity generation, no replay of failed
requests, same-endpoint recovery and zero hits at the direct/system-proxy sentinel.
Fixture timing observations are not a real-world recovery SLA. The test is part of the
shared PR/tag gate, not an optional smoke test.

The desktop minimum remains Firefox 140.0 because built-in data consent starts there;
no maximum version is set. CI's installed stable and Developer Edition browsers exercise
current behavior; a passing current-browser run is not a claim that a separate Firefox
140 run occurred. Record actual binary versions in gate logs and do not label missing
binaries a pass. See [Mozilla's version guidance](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).
