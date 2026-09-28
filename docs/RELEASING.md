# Firefox distribution releases

Listed releases use AMO as the canonical public distribution and automatic-update channel.
Version 1.1.1 uses Mozilla unlisted signing for self-distribution through GitHub. A final GitHub
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
`npm run e2e:ui`, `npm run e2e:fail-closed`, `npm run e2e:restart` and
`npm run e2e:socks-auth` on the exact commit. The last three use Firefox Developer
Edition for preinstalled unsigned-candidate restart coverage. Wait for both required CI checks. Follow
[the release checklist](RELEASE-CHECKLIST.md). Create and push the new immutable tag
only after every pre-submission gate passes. Never move or reuse a rejected tag.

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
submission/finalization and the main-only read-only status workflow. PR workflows never
receive them. Node's built-in HMAC-SHA256 creates a JWT valid for 60 seconds. API GETs use
a fixed AMO v5 origin, reject redirects and bound response sizes. Tokens, headers and raw
signing-client output are never logged or archived. No local or third-party signing occurs.

`amo-status.yml` inspects historical v1.0.0 without mutation. For authenticated local
administration, `node --experimental-strip-types src/release/amo-status.ts <version> [listed|unlisted]`
returns exit codes: approved 0, error 1, pending 20, rejected/disabled 30, absent 40.
The finalization workflow translates pending review into successful no-publication behavior.

## 1.1.0 candidate

The next release is 1.1.0: schema-2 migration, reserved Direct, independent identity
policies, saved-revision Apply, session-only credentials and the offline coordinate
picker. Authenticated AMO inspection found 1.1.0 absent before the version PR; v1.0.0
was listed/unreviewed. This records candidate selection, not approval. The final release
metadata and AMO status remain authoritative for publication.

## 1.1.1 self-distribution

Version 1.1.0 already exists on AMO as listed/unreviewed, so 1.1.1 is a distinct unlisted
submission. Neither the old tags nor earlier submissions are changed. AMO version numbers
are unique per add-on across channels. Unlisted signing may also require manual review;
upload acceptance alone never permits publication. The signing client waits at most two
minutes for approval, after which hourly finalization can finish later.

Install the signed XPI using Firefox Add-ons Manager > Install Add-on From File.
No custom update URL is configured; GitHub releases do not automatically update the
installation. A future higher listed AMO version may update it through Firefox's default
AMO update service. The older pending 1.1.0 will not replace 1.1.1. Unlisted signing does
not imply public listing approval; release notes and metadata explicitly record the channel.

The signed manifest may omit exactly one final LF byte. The verifier proves this by
reconstructing that single byte in memory and matching the original submission SHA-256;
it does not normalize JSON or allow value changes. All other payload files must remain
byte-identical. Release metadata records both manifest hashes and whether this occurred.
The downloaded signed XPI is never rewritten.
