# Manual testing

Automated coverage (`npm run check`, `npm run e2e`) covers logic, packaging and what a
page observes in real Firefox. The checks below need a human because they involve the UI,
a real proxy or a second Firefox instance.

## 0. Prepare

```bash
npm install
npm run build
npm run dev          # or: npm run dev -- --firefox="C:\Program Files\Firefox Developer Edition\firefox.exe"
```

Keep the browser console open (web-ext prints it with `--browser-console`).

## 1. Extension loads

1. `npm run dev` starts Firefox with the extension installed.
2. Open the popup. A fresh install shows **Get started** and does not contact a location
   service. Create a profile from **Manage Profiles** or **Create a profile**, then
   activate it. After activation the popup should show a public IP, a country/region/city,
   a timezone and coordinates. Browser routing does not override a proxy set in Firefox.
3. The audit should be _consistent_ once a page is open (the page-shim row turns ok).
4. Resize/close freely: no console errors mentioning net-identity.

## 1a. Manual location map

1. Open the options page. The map previews the resolved location while Identity is
   Automatic, including the accuracy circle once a lookup has succeeded.
2. Choose **Manual**. Blank latitude, longitude, accuracy and timezone fields fill from
   that resolved location. Fields you already typed stay as you left them.
3. Click the map, drag it, and use the zoom buttons. The centre pin and the latitude
   and longitude fields stay on the same point. Typing a latitude or longitude recentres
   the map.
4. **Use GeoIP location** replaces the manual point with the resolved one.
5. Disconnect the network and repeat the click and
   the typed coordinates. Both still update the fields. Save and activate: a page's
   geolocation matches the coordinates you saved.

## 2. Direct identity versus the observed egress

1. In the popup, press **Refresh Identity**.
2. Compare the shown public IP with an independent lookup from the same machine
   (`curl https://ipwho.is/`). They must match, because the identity is resolved from the
   observed egress, not from the proxy hostname.

## 3. Page-visible timezone and geolocation

On any ordinary HTTPS page open the devtools console and check:

```js
Intl.DateTimeFormat().resolvedOptions().timeZone; // identity timezone, e.g. America/Los_Angeles
new Date().getTimezoneOffset(); // matches that zone, DST-aware
new Date().toString(); // "… GMT-0800 (Pacific Standard Time)"
navigator.geolocation.getCurrentPosition((p) =>
  console.log(p.coords, p instanceof GeolocationPosition),
);
```

Expected: no permission prompt, coordinates close to the identity, `accuracy` around
20000, `instanceof` true. `npm run e2e` asserts this automatically; this manual step is
useful when debugging.

While a profile is active, a failed or still-pending identity must not fall through to
the machine position. The page receives the previous synthetic position, or a timeout /
position-unavailable error. Native results appear only after **Deactivate**.

## 4. Proxy routing with the bundled test proxy

```bash
node scripts/dev-proxy.mjs --port 8080
```

1. Create a profile: type `http`, host `127.0.0.1`, port `8080`, no credentials.
2. Activate it. Every request is logged by the proxy to stderr, e.g.
   `CONNECT example.com:443`.
3. The identity in the popup should change to the egress of the proxy chain (localhost,
   so in practice your own IP) while page requests demonstrably pass through the proxy.
4. Bypass check: open `http://localhost:8080/` — the proxy log must stay silent, because
   loopback is bypassed.
5. GeoIP check: the provider request must also appear in the proxy log (the GeoIP
   endpoint is deliberately not bypassed).
6. WebSocket check: from a page console, open `new WebSocket("wss://example.com/")` (and
   a `ws://` URL). The proxy log must show that connection. A WebSocket to
   `ws://127.0.0.1/` must not, because loopback is bypassed. `npm run e2e:websocket`
   runs this against a local proxy in real Firefox.

## 5. Challenge-based proxy authentication

```bash
node scripts/dev-proxy.mjs --port 8080 --require-auth user:pass
```

1. Create an HTTP proxy profile with username `user`, password `pass`; activate it.
2. Requests should succeed **without** a Firefox authentication prompt appearing. The
   proxy log shows the request; the audit shows no proxy error. A wrong password must
   not produce a stream of repeated `407` lines for the same request: the extension
   answers that challenge at most once. `npm run e2e:proxy-auth` checks the successful
   path in Firefox.
3. Remove the credentials (leave the password field empty and save, or tick _Remove the
   stored session credentials_), then press **Refresh Identity**. Firefox may now show
   its own authentication prompt — that is the expected fallback, and it proves the
   extension is not answering with wrong or leaked credentials.
4. Negative check: with the profile inactive, visit a site with HTTP basic auth. The
   extension must not answer that `WWW-Authenticate` challenge.

> Status: steps 1–4 are implemented and unit tested (`tests/proxy.test.ts`); the
> interactive prompt behaviour in step 3 has not been re-verified by hand yet. Record the
> result here when you do.

## 6. Credential lifetime

1. Set a proxy password and activate the profile.
2. Fully quit Firefox, start it again (`npm run dev`). The password must be **gone**:
   the profile still exists, the username is still there, the password field is empty and
   the "session credentials" badge is absent.
3. `about:debugging#/runtime/this-firefox` → net-identity → _Inspect_ → in the console:
   `browser.storage.local.get(null)` must contain no password, while
   `browser.storage.session.get(null)` holds the credential (if set in this session).

## 7. WebRTC policy

1. Activate a proxy profile and open `about:config` → `privacy.network.webRTCIPHandlingPolicy`
   → it should be `disable_non_proxied_udp` (the default for proxy profiles).
2. Switch the profile to `proxy_only`, save and reactivate → the pref follows.
3. Deactivate the profile → the pref returns to whatever was effective before
   activation (often `default`, but a prior user or enterprise value must come back).
   It must not be overwritten with `default` when that was not the previous value.
4. If another extension controls the preference, the popup must say _controlled by
   another extension_ rather than claiming success.

## 8. Identity audit edge cases

- **Another proxy extension**: enable a second proxy extension and check that the audit
  row _Firefox proxy settings_ reports the conflict instead of claiming consistency.
- **Provider failure**: block `ipwho.is` (e.g. via a hosts file or by using an offline
  proxy), press **Refresh Identity**, and confirm the audit shows _provider error_ while
  the proxy routing stays active.
- **Stale page**: with a profile active, switch to another profile in a second window
  whose page was loaded before the switch, then check the _Page shim_ row reports a
  stale generation instead of ok.

## 9. Packaging

```bash
npm run package
# then install artifacts/net-identity-<version>.zip in a clean profile
```

Confirm the packaged build behaves identically (the package is verified to contain only
runtime files, so differences usually mean a stale `dist/`).
