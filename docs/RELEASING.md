# Firefox distribution releases

AMO is the canonical public distribution and automatic-update channel. A final GitHub
Release offers the exact Mozilla-signed XPI, installable in normal Firefox. Listed upload
acceptance is **not approval**. Never rename an unsigned submission ZIP to imply signing.

## Immutable versions and gates

The extension ID remains `net-identity@jacek4yang.github.io`. Update `package.json`,
`package-lock.json` and `public/manifest.json` together in a release PR after the pipeline
implementation PR. Use a new higher semantic version. v1.0.0 and its historical assets
and AMO submission are immutable; its tag targets
`e3f8b22ed08e2acc13e93aad180b2e4e28f69325`.

Before tagging clean, merged main, run `npm ci`, `npm run check`, `npm run package`,
`npm run e2e:invariants`, `npm run e2e:websocket`, `npm run e2e:proxy-auth` and
`npm run e2e:ui` on the exact commit. Wait for both required CI checks. Follow
[the release checklist](RELEASE-CHECKLIST.md). Create and push the new immutable tag
only after every pre-submission gate passes. Never move or reuse a rejected tag.

## Phase 1: validate, record, submit

`.github/workflows/release.yml` checks out the exact tag, runs quality/package and the
shared four real-Firefox gates. Its submission job archives readable source with
`git archive`, hashes every production payload file, and records provenance in a **draft**
release. It submits with `web-ext sign --channel=listed`, API v5, `amo-metadata.json`,
the source archive and the existing AMO secrets. A manual run repeats gates only.

The tool queries the exact version before submission and afterwards. An existing version
is reused only with the matching original draft provenance. Text such as "duplicate"
is not proof of acceptance. If a client times out after POST, the next GET establishes
whether AMO accepted the version. Reruns do not POST an existing listed version.

The draft contains `submission-state.json` and `net-identity-source.zip`, no user installer.
It remains draft throughout review. If AMO refuses a new version while an earlier one
is pending, stop there; inspect the safe status and developer review activity. Do not
withdraw, delete or modify the earlier submission to bypass review.

## Phase 2: approval, signature verification, publication

`.github/workflows/amo-finalize.yml` runs hourly and supports manual dispatch on main.
An empty tag selects the oldest pending draft. It verifies that the selected semantic tag
is above v1.0.0 and belongs to main, then checks out that immutable commit. Submission
and finalization share a concurrency group. Jobs never wait indefinitely for review.

The tool authenticates to
`GET /api/v5/addons/addon/net-identity@jacek4yang.github.io/versions/v<version>/`:

- Unreviewed: successful pending result, no release publication or asset changes.
- Disabled/rejected: fail closed, no destructive operations or rewritten tag.
- Public: require exact listed version/ID, public add-on, enabled version, valid Mozilla
  HTTPS download URL and SHA-256. Unknown/malformed responses fail closed.

`file.is_mozilla_signed_extension` identifies a **Mozilla internal certificate**, not
ordinary AMO signing. Record it without requiring true. This distinction is documented
in [Mozilla's API](https://mozilla.github.io/addons-server/topics/api/addons.html) and
[Mozilla's clarification](https://github.com/mozilla/addons/issues/8822).

Download only from `addons.mozilla.org` or `addons.cdn.mozilla.net` over HTTPS, checking
every redirect (at most three), a 60-second deadline and 25 MB limit. Download requests
contain no authentication headers. Verify AMO SHA-256, ZIP structure/CRCs, manifest version,
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
- `release-metadata.json` — tag/commit, listed AMO version/file/status, signed-XPI and
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
administration, `node --experimental-strip-types src/release/amo-status.ts <version>`
returns exit codes: approved 0, error 1, pending 20, rejected/disabled 30, absent 40.
The finalization workflow translates pending review into successful no-publication behavior.
