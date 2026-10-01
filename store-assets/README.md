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

These are real extension pages from the unsigned local candidate in `dist/`,
rendered in Firefox using the existing Marionette UI harness. `web-ext` installs
that candidate as a temporary add-on in a disposable profile; these captures do
not demonstrate installation of a signed or released XPI. No marketing mockups, fabricated status labels, device
frames, or promotional paragraphs are overlaid. Popup captures center the
unchanged 380px popup on a plain canvas; options captures retain the normal layout.
All images are 1280 × 800 PNGs. The content viewport excludes browser chrome.
`screenshots/metadata.json` records the captured extension version, browser user
agent, fixture, dimensions, and SHA-256 of each image and captured UI source. Dark theme is fixed by a
Firefox preference for export reproducibility.

The disposable fixture uses the visibly labeled `Tokyo · Local demo` profile,
loopback host `127.0.0.1:9999`, synthetic coordinates `35.68, 139.76`, 20km
accuracy, and `Asia/Tokyo`. GeoIP is disabled. No remote proxy, public IP lookup,
real user data, passwords, usernames, browsing history, or authenticated session
is used. The audit honestly shows what this unverified manual fixture can and
cannot establish; it does not claim successful network egress verification.

### Upload order and captions

1. `screenshots/01-active-profile.png` — Switch routes and review the active
   profile's current identity
2. `screenshots/02-profile-management.png` — Manage saved proxy profiles and
   their independent identity settings
3. `screenshots/03-identity-audit.png` — Inspect routing, WebRTC policy, and
   identity consistency diagnostics
4. `screenshots/04-local-location-picker.png` — Set manual coordinates with the
   bundled local grid, without requesting map tiles

Use those captions as AMO screenshot labels. The images themselves contain only
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
