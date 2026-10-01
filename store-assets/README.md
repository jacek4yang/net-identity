# Firefox listing assets

## Icon

The original **route shield** consists of a continuous U-shaped route, two round
endpoints, and a faceted shield. A mint endpoint distinguishes the selected route.
There are no letters, third-party marks, or externally sourced artwork.

- Inspectable SVG master: `icons/icon.svg`
- AMO listing icon: `icons/icon-64.png` (64 × 64 RGBA)
- Alternative listing resolution: `icons/icon-32.png` (32 × 32 RGBA)
- Packaged extension artwork: `../public/icons/icon-{16,32,48,64,96,128}.png`

The listing PNGs are byte-identical to the corresponding packaged icons. All PNGs
have transparent surroundings and supersampled edges. Geometry in
`scripts/make-icons.mjs` generates both the SVG master and PNGs; edit that source,
then run `npm run icons`. No image dependencies, timestamps, fonts, or remote
resources are involved. `tests/icons.test.ts` verifies deterministic regeneration,
dimensions, alpha, and equality with listing artwork.

## Screenshots

**Verified 1.1.5 candidate capture:** [run 36863012728](https://github.com/jacek4yang/net-identity/actions/runs/36863012728)
captured these four PNGs from production source commit
`e5bb71c3fbcd777755a00a231d6e0da54ec2892d` after the mandatory deterministic
render gate passed. The map contains actual OpenFreeMap geography, including Tokyo CJK
labels and visible attribution. All image hashes and nine captured UI/renderer hashes
matched the versioned production package; [capture-review.json](screenshots/capture-review.json)
records independent visual acceptance. The raw metadata's `requiresVisualReview` flag
is retained as captured; the adjacent review records its completion. This is unsigned
candidate evidence, not Mozilla approval, signed installation or AMO publication.
The historical [1.1.4 capture review](https://github.com/jacek4yang/net-identity/blob/4d99c9a0eeeb3217ae9c8fd32dbcbdd428dc1370/store-assets/screenshots/capture-review.json), immutable tags and 1.1.3 dated publication record remain unchanged.

These are real extension pages from the unsigned local candidate in `dist/`,
rendered in Firefox using the existing Marionette UI harness. `web-ext` installs
that candidate as a temporary add-on in a disposable profile; these captures do
not demonstrate installation of a signed or released XPI. No marketing mockups, fabricated status labels, device
frames, or promotional paragraphs are overlaid. Popup captures center the
unchanged 380px popup on a plain canvas; options captures retain the normal layout.
The audit view is a lossless crop of the actual identity and diagnostics cards,
reframed at native scale with plain matching-background margins. No status content is altered.
All images are 1280 × 800 PNGs. The content viewport excludes browser chrome.
`screenshots/metadata.json` records the captured extension version, browser user
agent, fixture, dimensions, and SHA-256 of each image and captured UI source. Dark theme is fixed by a
Firefox preference for export reproducibility.

The disposable fixture uses the visibly labeled `Tokyo · Local demo` profile,
loopback host `127.0.0.1:9999`, synthetic coordinates `35.68, 139.76`, 20km
accuracy, and `Asia/Tokyo`. GeoIP is disabled. No remote proxy, public IP lookup,
real user data, passwords, usernames, browsing history, or authenticated session
is used. The live-map capture explicitly contacts OpenFreeMap through a narrow local
provider-only capture proxy; provider imagery is real while profile data is synthetic. The audit honestly shows what this unverified manual fixture can and
cannot establish; it does not claim successful network egress verification.

### Candidate upload order and captions

1. `screenshots/01-active-profile.png` — Switch profiles and review the current identity in one compact popup
2. `screenshots/02-profile-management.png` — Manage proxy profiles and save identity settings before applying them
3. `screenshots/03-identity-audit.png` — Inspect routing, WebRTC policy and identity checks, including unverified states
4. `screenshots/04-local-location-picker.png` — Choose manual coordinates on an optional OpenFreeMap basemap, with visible attribution

The captions match the prepared 1.1.5 copy in `listing-en-US.json`. Publish only after
the exact listed release is approved and finalized, with operator reconciliation of
existing manually uploaded preview IDs. The images themselves contain only
extension UI. Upload artwork through the listing editor after human review;
these files are deliberately separate from the signing and release pipeline.
They are not extension runtime assets and must not be copied into the XPI.

### Reproduce

With Node 22+ and an installed official Firefox Developer Edition:

```sh
npm ci
npm run build
npm run icons
node scripts/e2e-ui.mjs --firefox /absolute/path/to/firefox \
  --screenshots store-assets/screenshots
npx vitest run tests/icons.test.ts
```

The screenshot flag selects a short export path in the same real-Firefox harness;
normal `npm run e2e:ui -- --firefox ...` continues to run the existing interaction
regressions. Export fails rather than accepting incorrect image dimensions.
Review each regenerated image before uploading: viewport clipping, installed
fonts, and Firefox rendering may differ by host. No AMO credentials are needed to
regenerate the assets, and the export command never uploads them.

## Controlled publication

The reviewed English copy is in `listing-en-US.json`. The separate main-only
listing workflow waits for the exact listed version and finalized signed GitHub
Release before writing public AMO metadata or uploading media. It is dry-run by
default and uses resumable receipts; see [AMO listing publication](../docs/AMO-LISTING.md).

## Public listing verification (2026-10-01)

The icon and all four screenshots were published through the AMO browser editor after
1.1.3 was approved and its signed GitHub release finalized. Public preview IDs are
`416773`, `416774`, `416775`, `416776`, in the order above. All four downloaded full-size
1280 × 800 screenshots and the 128px icon are pixel-identical to the assets committed
with v1.1.3; AMO re-encoded their PNG bytes. The original unsigned-candidate capture
provenance remains unchanged.

[publication-v1.1.3.json](publication-v1.1.3.json) records public URLs, captions and
source/download hashes. Public description and privacy policy matched the reviewed copy
semantically after the browser editor's Markdown-to-HTML rendering and the documented
“missing-credential” whitespace correction. This is public verification evidence, **not**
a trusted listing-workflow receipt. The publisher must stop on these existing manually
uploaded previews until reviewed operator reconciliation; do not fabricate or auto-adopt
a receipt from this file. No listing-workflow execution was used for this publication.
