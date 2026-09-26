# Releasing

`package.json` `version` is the version that ships. `public/manifest.json` must use the
same value, and the tag is `v` plus that version (for example `v0.2.0`).
`npm run check:version` rejects a manifest mismatch, a tag that disagrees, and a version
that is not newer than one already published (`PUBLISHED_VERSIONS`). The extension id
`net-identity@jacek4yang.github.io` never changes.

addons.mozilla.org (AMO) is the ordinary-user install and update channel. A listed
submission is signed by Mozilla and updates installed users automatically once Mozilla
approves it. A GitHub Release is the engineering record, not the installer.

## One-time AMO setup

1. Create an API key at <https://addons.mozilla.org/developers/addon/api/key/>.
2. In this GitHub repository add the Actions secrets **`AMO_JWT_ISSUER`** (the JWT
   issuer) and **`AMO_JWT_SECRET`** (the JWT secret). Keep them out of the repository,
   pull requests and logs.
3. The tag workflow is the only workflow that reads them. No pull-request workflow has
   access to a secret, so a fork cannot reach them.

There is no public listing URL until Mozilla accepts the first listed submission. Do not
invent one. Update the README link in the release that first becomes public.

## Release checklist

Run `docs/RELEASE-CHECKLIST.md` on the exact release commit before tagging. A failed
security or correctness item blocks the release; fix it on a branch and ship a **new**
version instead of moving the tag.

## Tag

On a clean `main`, after `npm run check` and the local Firefox harnesses
(`npm run e2e:invariants`, `npm run e2e:websocket`, `npm run e2e:proxy-auth`):

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

The tag push starts `.github/workflows/release.yml`, which:

1. checks out the tag;
2. runs `quality` (`npm run check`, including the tag/version check) and `npm run package`;
3. runs the `firefox` job (the same reusable real-Firefox invariants as pull-request CI);
4. only then, in `submit`, builds the production package, archives human-readable source,
   and submits the version to AMO with `web-ext sign --channel=listed` using
   `amo-metadata.json` and `--upload-source-code`;
5. in `publish`, creates or updates the GitHub Release from the tested tag.

A `workflow_dispatch` run repeats steps 1–3 only. It never submits and never publishes.

## What the GitHub Release is

It is the engineering record for the tag. `publish` runs only after `quality`, the
`firefox` gate and the AMO `submit` job succeeded, so a failed gate or a missing AMO
credential means no release is created. It attaches:

- the production package that was submitted to AMO (`artifacts/*.zip`);
- the human-readable source archive (`net-identity-source.zip`);
- `SHA256SUMS.txt`, a `sha256sum`-compatible checksum file;
- `release-metadata.json`, the machine-readable manifest tying the version, tag, commit,
  extension id and artifact hashes together.

Release notes list only the merged pull-request titles for that tag, with a preamble
that points ordinary users at AMO. A rerun for an existing tag edits the release and
replaces its assets instead of failing. The attached unsigned zip is labeled as the
submission artifact, never as the user installer.

## Submission is not approval

`web-ext` returns as soon as AMO accepts the upload. Mozilla reviews listed versions
asynchronously, so the version is submitted but not yet public. The workflow prints this
when it succeeds. Do not describe an accepted submission as approved or as an available
install.

Rerunning the workflow for a version AMO already has is safe: `scripts/submit-listed.mjs`
treats a duplicate version as success and does not submit it again.

If the AMO secrets are missing, the `submit` job fails and reports that `AMO_JWT_ISSUER`
and `AMO_JWT_SECRET` must be configured. No version is submitted.

## After a review comment

Fix the code on a branch, merge it through CI, bump `package.json` and
`public/manifest.json` together, and push a new `vX.Y.Z` tag. Do not move or reuse the
rejected tag, and do not rebuild that version in place.
