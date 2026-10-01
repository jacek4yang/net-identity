# Publish an approved public AMO listing

`amo-listing.yml` is a separate, manual, main-only workflow. It does not sign extensions,
submit versions, finalize releases, delete previews, change the add-on's identity or
create credentials. It uses the existing `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` exclusively
in the trusted job; GitHub permissions remain read-only. The shared `amo-distribution`
concurrency group prevents overlap with submission/finalization.

## Preconditions and reviewed inputs

- `release-config.json` must select `listed`
- Package and manifest versions must agree, using the fixed extension ID
- That exact AMO version must be listed, enabled, public and `current_version`
- Its GitHub Release must already be public, non-prerelease, with matching tag commit,
  accepted listed provenance, AMO SHA-256 and permanent Firefox signature proof
- The tag must belong to main
- Screenshot metadata must match the version; all four image hashes/dimensions and all
  six captured UI hashes must match the finalized release's production payload
- The 128px icon must match the finalized release payload

`store-assets/listing-en-US.json` contains reviewed public summary, description,
privacy text and four captions. Only en-US is authored here. Existing other locales
are carried through without alteration. Name, slug, categories, EULA, account settings,
version metadata and signing channels are never written. Revisit this file whenever
actual privacy behavior changes; the privacy policy is intentionally a reviewed copy,
not an automatic upload of arbitrary Markdown from the repository. Description and privacy
use AMO's supported HTML (`strong`, `br`, `ul`, `ol`, `li`, `a`, `code`), with no raw
Markdown headings or pipe tables. AMO's frontend strips unsupported elements such as `p`.

A dry run is the default. It produces a secret-free plan and receipt artifact. When the
exact version is not yet public/current/listed it reports not-ready without writes.
Other invalid provenance is an error, not permission to weaken a gate.

```sh
gh workflow run amo-listing.yml --ref main -f dry_run=true
# Inspect the plan and reviewed repository copy/assets first.
gh workflow run amo-listing.yml --ref main -f dry_run=false -f receipt_run_id=PREVIOUS_RUN_ID
```

## Receipt and interruption handling

The `amo-listing-receipt` artifact contains only the plan/receipt. The receipt binds the
version and complete copy/asset plan hash to accepted metadata writes, icon upload and
each created preview's source hash, ID and URL. It is saved immediately after confirmed
operations, before subsequent caption updates, and uploaded on failure as well as success.
Before **every** PATCH/POST, a pending-operation intent is persisted with `attemptedWrites`;
preview-create intent also records the source hash, position and prior preview IDs.
The accepted result and removal of pending intent are saved together using atomic
same-directory temp-file rename. Any pending operation stops resumed runs, including dry
runs, for operator reconciliation even when AMO still shows no previews. An empty remote
read is not evidence that an earlier request failed.
Keep a copy before the 90-day retention expires.

To resume the same plan, pass the previous run ID:

```sh
gh workflow run amo-listing.yml --ref main -f dry_run=true -f receipt_run_id=123456789
gh workflow run amo-listing.yml --ref main -f dry_run=false -f receipt_run_id=123456789
```

Every run after the first must supply the latest prior listing run's receipt. The guard
excludes the current and future queued runs using GitHub run numbers, requires a completed
run, and rejects missing artifacts. A runner loss therefore cannot authorize a fresh upload.
GitHub **Re-run jobs** is rejected because it reuses the same run ID/number; start a fresh
workflow dispatch with the failed run's receipt instead. Empty initialization is allowed
only for run number 1. Missing or deleted prior history, including a sequence containing
only earlier non-main runs, requires reconciliation rather than assuming no writes.
History is bounded to 100 runs and must be complete; older/truncated history requires
operator reconciliation. A validated receipt with no attempted writes or accepted results
can start a changed version/copy/asset plan, so dry runs do not lock the plan permanently.

Only receipts from this repository's main `workflow_dispatch` listing workflow whose
commit belongs to main are accepted. Source/version changes invalidate any receipt that attempted writes.
Accepted-but-moderated text is not resubmitted on each resume. The public readback still
reports whether that text has become visible.

Existing preview IDs and stable image URLs must match a trusted receipt; an empty listing supports first
publication. Unknown, missing or changed preview IDs stop before any listing mutations
and are printed for operator reconciliation. Captions/position are not proof of image
ownership. Only Mozilla's numeric `modified` URL query parameter is ignored when comparing
image URLs: caption saves and asynchronous resizing both update that cache-buster.
Origin, path, other query parameters and preview IDs remain exact. Caption responses
must retain the target ID and stable image URL; their observed URL is saved atomically
with the cleared operation intent. No screenshot is deleted or silently replaced. Changed assets or existing
unmanaged screenshots require a reviewed operator reconciliation, not a reset switch.

A timed-out or malformed POST may have succeeded. The workflow does **not** automatically
retry it, within or across runs. Re-read the listing and reconcile any new preview ID against the prior plan
and source image before resuming; never fabricate a receipt merely to bypass the guard.
If the operation succeeded but no receipt survived, reconcile it explicitly. Do not run
again with an empty receipt when previews already exist.

## API and verification limits

The client has fixed endpoint/method/field allowlists, rejects authenticated redirects,
limits responses to 2 MB and individual PNGs to 5 MB, and applies a 30-second API deadline.
It never logs raw responses, credentials, JWTs or child-process diagnostics. A 401/403
stops execution without requesting a new token or modifying permissions.

- Summary/description: JSON PATCH on the fixed add-on
- Privacy policy: JSON PATCH on `eula_policy/`, omitting EULA
- Icon: multipart PATCH on the add-on
- New screenshots: multipart POST on `previews/`
- Caption/order: JSON PATCH on the returned numeric preview ID

Immediately before every write, the public/current/listed gate is rechecked and its
version ID, file ID and SHA-256 must equal the initially finalized proof. Copy/privacy
locales are re-read and compared before PATCH; a concurrent change stops rather than
replaying an old locale map. AMO offers no documented conditional-write transaction here,
so an edit racing the final check still requires normal operator coordination.

The confirmed icon source hash prevents reupload on resume. Its returned URL is only an
observation: asynchronous resizing can replace an initial default URL, and that change
does not invalidate the receipt. A confirmed upload is not proof of a rendered icon.

Icon resizing, AMO caches and listing-content moderation may delay visibility. Successful
writes are reported as accepted/pending, not public approval. The final readback makes
unauthenticated API GETs to check public text and preview captions. Even when those match,
rendered screenshots/icon and the actual public listing need visual verification. This
workflow does not certify that asynchronous media processing or human moderation finished.

Official references:

- [AMO add-on, privacy and media API](https://mozilla.github.io/addons-server/topics/api/addons.html)
- [Existing account JWT authentication](https://mozilla.github.io/addons-server/topics/api/auth.html)

- [AMO frontend supported HTML sanitizer](https://github.com/mozilla/addons-frontend/blob/master/src/amo/utils/index.js)
- [Privacy-policy rendering through the same sanitizer](https://github.com/mozilla/addons-frontend/blob/master/src/amo/pages/AddonInfo/index.js)

- [Preview URL cache-buster and auto-updated modified timestamp](https://github.com/mozilla/addons-server/blob/master/src/olympia/amo/models.py)
- [Asynchronous preview resizing saves the model](https://github.com/mozilla/addons-server/blob/master/src/olympia/addons/tasks.py)
