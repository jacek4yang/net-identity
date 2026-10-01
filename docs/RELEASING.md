# Firefox distribution releases

Listed releases use AMO as the canonical public distribution and automatic-update channel.
Versions 1.1.1 and 1.1.2 use Mozilla unlisted signing for self-distribution through GitHub. A final GitHub
Release offers the exact Mozilla-signed XPI, installable in normal Firefox. Listed upload
acceptance is **not approval**. Never rename an unsigned submission ZIP to imply signing.

## Immutable versions and gates

The extension ID remains `net-identity@jacek4yang.github.io`. Update `package.json`,
`package-lock.json` and `public/manifest.json` together in a release PR after the pipeline
implementation PR. Use a new higher semantic version. v1.0.0 and its historical assets
and AMO submission are immutable; its tag targets
`e3f8b22ed08e2acc13e93aad180b2e4e28f69325`.

Before tagging clean, merged main, run `npm ci`, `npm run check`, `npm run package`,
`npm run e2e:invariants`, `npm run e2e:websocket`, `npm run e2e:proxy-auth`,
`npm run e2e:ui`, `npm run e2e:map-fallback`, `npm run e2e:map`,
`npm run e2e:fail-closed`, `npm run e2e:restart`,
`npm run e2e:socks-auth` and `npm run e2e:flap` on the exact commit. The outage, restart, auth-loss and flap checks use Firefox Developer
Edition for preinstalled unsigned-candidate restart coverage. Wait for both required CI checks. Follow
[the release checklist](RELEASE-CHECKLIST.md). Create and push the new immutable tag
only after every pre-submission gate passes. Never move or reuse a rejected tag.

The online-map gates are distinct: `e2e:map-fallback` checks degraded rendering and the
broker/privacy boundary; `e2e:map` must show actual imagery with a working WebGL display
(CI uses Xvfb/Mesa). Test-only TLS trust is confined to disposable browser profiles, not
extension/runtime or user security settings. A successful fallback does not prove real
map rendering. Before submission, reviewer notes must explain explicit online-map
activation, OpenFreeMap's viewed-region/IP exposure, routing/consent limits, bundled
MapLibre code/worker and dependency notices. Preserve the offline coordinate fallback.

For the next map release, 1.1.4 is currently a provisional unused patch: the authenticated
owner DevHub version list inspected on 2026-10-01 contained listed 1.1.3/1.1.0,
self-distributed 1.1.2/1.1.1 and disabled 1.0.0, with no 1.1.4 or additional page; remote
tags also stopped at 1.1.3. Recheck immediately before the separate release PR/submission.
Do not bump versions in the implementation PR or infer availability from public API 404
alone. See [the map release readiness checklist](RELEASE-CHECKLIST.md#next-listed-map-release-provisional-114).

## Phase 1: validate, record, submit

`.github/workflows/release.yml` checks out the exact tag, runs quality/package and the
shared real-Firefox gates. Its submission job archives readable source with
`git archive`, hashes every production payload file, and records provenance in a **draft**
release. The tagged `release-config.json` selects `listed` or `unlisted`; historical
v1.1.0 defaults to listed. It submits with `web-ext sign --channel=<channel>`, API v5, `amo-metadata.json`,
the source archive and the existing AMO secrets. A manual run repeats gates only.

The tool queries the exact version before submission and afterwards. An existing version
is reused only with the matching original draft provenance. Text such as "duplicate"
is not proof of acceptance. If a client times out after POST, the next GET establishes
whether AMO accepted the version. Reruns do not POST an existing version.

The draft contains `submission-state.json` and `net-identity-source.zip`, no user installer.
It remains draft throughout review. If AMO refuses a new version while an earlier one
is pending, stop there; inspect the safe status and developer review activity. Do not
withdraw, delete or modify the earlier submission to bypass review.

## Phase 2: approval, signature verification, publication

`.github/workflows/amo-finalize.yml` runs hourly and supports manual dispatch on main.
Successful submission dispatches finalization immediately; hourly checks handle later signing.
An empty tag selects the oldest pending draft independently in each channel, so a pending
listed review cannot delay an approved unlisted release. It verifies that the selected semantic tag
is above v1.0.0 and belongs to main, then checks out that immutable commit in `release-tag/`. Trusted main supplies the
finalization tools while all tag/package/provenance checks use the exact tagged working
directory. Tool fixes therefore require no tag mutation or extension rebuild. Submission
and finalization share a concurrency group. Jobs never wait indefinitely for review.

The tool authenticates to
`GET /api/v5/addons/addon/net-identity@jacek4yang.github.io/versions/v<version>/`:

- Unreviewed: successful pending result, no release publication or asset changes.
- Disabled/rejected: fail closed, no destructive operations or rewritten tag.
- Public: require exact version/channel/ID, enabled version, valid Mozilla
  HTTPS download URL and SHA-256. Listed releases also require a public add-on listing;
  unlisted signing is independent of the listing status. Unknown/malformed responses fail closed.

`file.is_mozilla_signed_extension` identifies a **Mozilla internal certificate**, not
ordinary AMO signing. Record it without requiring true. This distinction is documented
in [Mozilla's API](https://mozilla.github.io/addons-server/topics/api/addons.html) and
[Mozilla's clarification](https://github.com/mozilla/addons/issues/8822).

Download only from `addons.mozilla.org` or `addons.cdn.mozilla.net` over HTTPS, checking
every redirect (at most three), a 60-second deadline and 25 MB limit. Download requests
authenticate the initial unlisted file request on the exact AMO file endpoint with a
short-lived JWT, as web-ext does. No authentication is sent to redirects or CDN hosts. Verify AMO SHA-256, ZIP structure/CRCs, manifest version,
stable ID, AMO update channel and exact original production payload hashes. Only signature
files may be added. Never rebuild or mutate the downloaded XPI.

Install that file permanently in a fresh **normal stable Firefox** profile with signature
enforcement enabled. Require Firefox's signed state, matching version/ID, no custom update
URL and a non-temporary installation. Archive this verification result in release metadata.
Requery approval and rehash bytes before publication. Signature entry presence alone is
never sufficient evidence of signing.

Final public assets:

- `net-identity-<version>-firefox-signed.xpi` — primary normal-user installer;
- `net-identity-source.zip` — exact tagged source submitted for review;
- `release-metadata.json` — tag/commit/channel, AMO version/file/status, signed-XPI and
  source hashes, Firefox signature evidence and original submission provenance;
- `SHA256SUMS.txt` — hashes the three artifacts above (not itself).

Draft retries verify provenance before replacing byte-identical artifacts. Public reruns
verify artifacts without rewriting them. The final public release contains no unsigned ZIP.
Release notes use actual merged PR titles reachable from the tag, explain the signed install
and AMO update channel, and identify the tag/version/commit. When AMO becomes public, verify
its canonical URL and update README via a separate docs PR; do not modify tagged source.

## Credentials and diagnostics

Existing repository secrets `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` are used only by trusted
submission/finalization, the main-only read-only status workflow, and the separate
manual main-only listing publisher. The publisher changes only reviewed public listing
copy/media after exact listed-version approval and release finalization; it cannot sign
or submit a version. Its read-only GitHub permissions, fixed AMO endpoints and resumable
write receipts keep it separate from signing. PR workflows never receive these secrets. Node's built-in HMAC-SHA256 creates a JWT valid for 60 seconds. API GETs use
a fixed AMO v5 origin, reject redirects and bound response sizes. Tokens, headers and raw
signing-client output are never logged or archived. No local or third-party signing occurs.

`amo-status.yml` inspects historical v1.0.0 without mutation. For authenticated local
administration, `node --experimental-strip-types src/release/amo-status.ts <version> [listed|unlisted]`
returns exit codes: approved 0, error 1, pending 20, rejected/disabled 30, absent 40.
The finalization workflow translates pending review into successful no-publication behavior.

## Historical 1.1.0 candidate selection

At that candidate-selection stage, the next release was 1.1.0: schema-2 migration, reserved Direct, independent identity
policies, saved-revision Apply, session-only credentials and the offline coordinate
picker. Authenticated AMO inspection found 1.1.0 absent before the version PR; v1.0.0
was listed/unreviewed. This records candidate selection, not approval. The final release
metadata and AMO status remain authoritative for publication.

## 1.1.1 self-distribution

At the time 1.1.1 was selected, version 1.1.0 existed on AMO as listed/unreviewed,
so 1.1.1 was a distinct unlisted submission. Neither the old tags nor earlier submissions are changed. AMO version numbers
are unique per add-on across channels. Unlisted signing may also require manual review;
upload acceptance alone never permits publication. The signing client waits at most two
minutes for approval, after which hourly finalization can finish later.

Install the signed XPI using Firefox Add-ons Manager > Install Add-on From File.
No custom update URL is configured; GitHub releases do not automatically update the
installation. A future higher listed AMO version may update it through Firefox's default
AMO update service. The older 1.1.0 cannot replace the higher 1.1.1. Unlisted signing does
not imply public listing approval; release notes and metadata explicitly record the channel.

The signed manifest may omit exactly one final LF byte. The verifier proves this by
reconstructing that single byte in memory and matching the original submission SHA-256;
it does not normalize JSON or allow value changes. All other payload files must remain
byte-identical. Release metadata records both manifest hashes and whether this occurred.
The downloaded signed XPI is never rewritten.

## 1.1.2 fail-closed security release

Version 1.1.2 follows merged security PR #74 and keeps the unlisted channel selected by
`release-config.json`. It is the first schema-3 version: a non-secret applied route is
stored separately from editable saved profiles, so full Firefox restart cannot make an
unapplied Direct edit effective. Proxy outages, lost session credentials, and unsafe
startup state fail external requests instead of falling back to Direct. The release
gate includes the SOCKS outage, event-page restart, full-restart, authenticated SOCKS,
HTTP/HTTPS/WS/WSS, DNS, and zero direct-origin leak checks. At the time of that release, v1.1.0 was listed/unreviewed. Historical tags, releases
and AMO submissions remain unchanged; see the dated status below.

## Published 1.1.3 (2026-10-01)

[Release PR #77](https://github.com/jacek4yang/net-identity/pull/77) merged to main
`dbb9b6791fd56700017e97d6c7d3fd9d89abf62d`; immutable tag `v1.1.3` points to that
commit. [Tag release gates and submission](https://github.com/jacek4yang/net-identity/actions/runs/36816346305)
passed. AMO accepted the exact listed version at 04:45:25 UTC and approved it at
04:51:07 UTC (version ID `6530342`, public file `5074485`). The initial finalizer
correctly waited for review. A later [finalizer run](https://github.com/jacek4yang/net-identity/actions/runs/36820625476)
verified the Mozilla bytes and permanent installation in Firefox 157 with signature
enforcement, then published the [GitHub release](https://github.com/jacek4yang/net-identity/releases/tag/v1.1.3)
at 05:37:42 UTC.

The primary `net-identity-1.1.3-firefox-signed.xpi` is 78,152 bytes, with SHA-256
`26738474bf3e80ca327b4aaae9ca88c9ea17cc8c3beefcc7f9052cba0fc50831`, matching AMO.
The release includes source, checksums and `release-metadata.json`; its proof records
`signedState: 2`, `signatureRequired: true`, `temporarilyInstalled: false`, and no
custom update URL. All six captured UI source hashes match the finalized payload.

The [public AMO listing](https://addons.mozilla.org/en-US/firefox/addon/net-identity/)
was updated through the authenticated browser editor at 05:47–05:49 UTC: custom icon,
four captions/screenshots, description and privacy policy. Public API and rendered-page
checks confirmed the changes; downloaded media matched the committed assets pixel for
pixel. [The public verification record](../store-assets/publication-v1.1.3.json)
contains preview IDs, ordering, captions and source/download hashes.

This was a manual browser publication, not a listing-workflow run. No trusted workflow
receipt was created. The automatic publisher must continue to reject these existing
previews until a separate reviewed operator reconciliation establishes their provenance;
this public evidence file does not authorize automatic adoption or replay. The browser
editor accepted Markdown, while the reviewed repository copy is HTML and the public API
returns rendered HTML. Semantic text was verified, including a corrected whitespace typo
in “missing-credential”; raw serialization equality is not claimed. EULA remained null.

## Historical 1.1.3 candidate selection (2026-10-01, before publication)

The following records the candidate-stage evidence available before the release above.

The public [v1.1.0 GitHub release](https://github.com/jacek4yang/net-identity/releases/tag/v1.1.0)
now records listed distribution and the canonical
[AMO URL](https://addons.mozilla.org/en-US/firefox/addon/net-identity/).
The public API and rendered listing were independently verified on 2026-10-01:
the add-on was enabled/public and its then-current listed version was 1.1.0. The API was
rechecked at 04:13 UTC. This supersedes earlier notes that relied only on GitHub
release provenance; historical pending-review observations remain dated history.

At that stage, version 1.1.3 was the selected schema-4 release candidate, with session-only usernames
and passwords, passive SOCKS health, bounded cooldown and repeated-flap coverage.
The implementation was squash-merged in [PR #76](https://github.com/jacek4yang/net-identity/pull/76)
to main commit `104a97706be1421574915d921d3696d9870a1095`; its
[exact-head CI](https://github.com/jacek4yang/net-identity/actions/runs/36809016499) passed.
The missing-session-credential fix was subsequently merged in
[PR #78](https://github.com/jacek4yang/net-identity/pull/78), including the explicit
Firefox-protected browser-service boundary. The separate release PR was prepared to align version
1.1.3, listed distribution and reviewer material. Its merged commit
was required to pass every release gate before the immutable v1.1.3 tag is created.

The authenticated main-only [status run](https://github.com/jacek4yang/net-identity/actions/runs/36807778410)
on 2026-10-01 at 02:51:21 UTC reported the add-on public and version 1.1.3 absent.
That records the original candidate selection. The later authenticated main-only
[recheck](https://github.com/jacek4yang/net-identity/actions/runs/36814633282)
on main `89e4c0e2ccc54fe476e5e74e9d5d3943973d4ef2` at 04:20:22 UTC the same day
again returned add-on public and version 1.1.3 absent. Neither check reserves the version
or establishes submission, signing or publication; recheck if intervening submissions occur.
The candidate `release-config.json` selected listed for the intended public 1.1.3 release.
No submission, signing, tag or publication is implied by this configuration change.
Neither the older listed release nor any historical signing assets are changed.

Candidate screenshots are prepared from actual clean Firefox UI with fixture-only data.
An unsigned candidate is acceptable for asset preparation when provenance records that
fact. Screenshots do not satisfy any signing gate. AMO icon/preview uploads are separate
listing API mutations, separate from version signing; do not mix them into the
credential-isolated submission/finalizer pipeline. Publish listing copy/media only after
the exact finalized listed version is public/current and the listing publisher verifies
its signature/provenance and captured UI payload. Rendering and asynchronous icon/media
processing still require visual readback.

The ordinary-request missing-credential gate does not cancel all Firefox-protected
browser-service requests. They can still reach the selected proxy anonymously if it
accepts that mode. Require upstream rejection of anonymous clients for browser-wide
account identity; neither the release nor listing must claim a universal kill switch.

## Provisional 1.1.4 release preparation (2026-10-01)

The separate release candidate aligns package, lockfile and manifest to 1.1.4 with
listed distribution, based on map implementation [PR #81](https://github.com/jacek4yang/net-identity/pull/81),
squash-merged as `8b11d42df339fd55a15ab7c751e2bfba22da91e4`. Its corrected production
[CI run](https://github.com/jacek4yang/net-identity/actions/runs/36846371498) passed
all ten deterministic Firefox suites and unsigned-installer rejection. Real-render
artifacts were independently inspected and their runtime hashes matched the packaged
production payload. This is implementation evidence, not a claim that 1.1.4 is signed
or publicly available.

Remote tags still ended at v1.1.3 and public AMO still served 1.1.3 at the 09:49 UTC
check; public v1.1.4 returned 404. At 09:51 UTC, the authenticated owner's complete
DevHub history again showed only 1.1.3, 1.1.2, 1.1.1, 1.1.0 and 1.0.0, with no
pending version, 1.1.4 or additional page. These observations neither reserve the
version nor establish submission; recheck if intervening submissions occur.

Final versioned-candidate validation, provider-dependent asset capture and review remain
required. The manual capture workflow is now merged, but actual-provider screenshots must
be captured from the published 1.1.4 candidate branch and verified before being claimed
as new release assets. Keep the existing listed submission/finalizer and immutable
historical 1.1.3 release/publication evidence. Manual AMO previews still require reviewed
operator reconciliation, never automatic adoption.
