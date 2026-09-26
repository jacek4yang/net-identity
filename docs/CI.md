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

The job installs a supported stable desktop Firefox from Mozilla's APT repository and
runs the three deterministic harnesses:

- `npm run e2e:invariants` – fail-closed controlled geolocation, `Date`/`Intl`
  timezone consistency, supported frames, and WebRTC apply/restore.
- `npm run e2e:websocket` – `ws`/`wss` routing through the active proxy while a
  loopback WebSocket stays bypassed.
- `npm run e2e:proxy-auth` – an authenticated HTTP proxy, with a correct password
  accepted and a wrong password challenged a bounded number of times.

Every request goes to a loopback page, proxy or WebSocket server. The harnesses never
contact the public GeoIP provider, so the gate cannot fail because an external service
is slow or down.

`npm run e2e` (the smoke test) is deliberately **not** in CI: it needs the public GeoIP
provider. It stays a release-candidate smoke item (#21) and a local check.

On failure the job uploads `firefox-*.log`. The logs contain loopback ports and the
bundled test proxy's throwaway `user:pass`; no repository secret is used by this job.

## One-time repository setting (required gate)

`quality` is already a required status check on `main`. To make the browser gate block
merges as well, add `firefox` to the required status checks:

1. Repository **Settings → Branches → Branch protection rules → `main`**.
2. Under **Require status checks to pass before merging**, add **`firefox`** in
   addition to `quality`.

The exact API call is:

```bash
gh api -X PATCH \
  repos/jacek4yang/net-identity/branches/main/protection/required_status_checks \
  -f strict=true -f 'contexts[]=quality' -f 'contexts[]=firefox'
```

Until the setting is changed, the job still runs on every pull request and its result
is visible, but a merge is not blocked by it. It is added to the required context list
once the job has gone green at least once, so a missing or broken job cannot block
unrelated work.

## Running the same gate locally

```bash
npm ci
npm run build
npm run e2e:invariants -- --firefox "<path to Firefox>"
npm run e2e:websocket -- --firefox "<path to Firefox>"
npm run e2e:proxy-auth -- --firefox "<path to Firefox>"
```

A missing Firefox binary exits with code `2` and an `INCONCLUSIVE` message; it is never
reported as a pass.
