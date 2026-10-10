# Optional live OpenFreeMap screenshot capture

This capture path is separate from deterministic offline map security tests.
It never publishes a listing, changes release artifacts, or proves signing.

1. Build the final candidate with `npm run build:prod`.
2. Pass the mandatory real-render gate, using a WebGL-capable Firefox display:
   `xvfb-run -a node scripts/e2e-map.mjs --firefox /path/to/firefox`.
3. In a new output directory, run:

   ```sh
   LIBGL_ALWAYS_SOFTWARE=1 xvfb-run -a node scripts/e2e-ui.mjs \
     --firefox /path/to/firefox --live-map \
     --screenshots artifacts/listing-map --timeout 180
   ```

The manual `Capture real OpenFreeMap listing images` workflow performs those
steps in CI and returns a candidate artifact for inspection. It first requires
the deterministic map-render gate to pass; provider-dependent artwork capture
is not part of the normal mandatory test suite.

## What is real and what is synthetic

The actual bundled renderer requests OpenFreeMap's Liberty map data after the
production **Load online map** action. Geography is real provider data, never
the security harness's synthetic vector/raster fixtures. Only the profile,
Tokyo coordinates (35.68, 139.76), 20km accuracy, and loopback proxy are synthetic.
GeoIP stays disabled; no real public IP, username, password or browsing history
appears in the pictures. OpenFreeMap necessarily sees the capture runner's
network-visible IP and the viewed map area; its provider terms/privacy apply.

The loopback proxy listens only on 127.0.0.1:9999 and permits only CONNECT to
`tiles.openfreemap.org:443`. Other destinations and plain HTTP requests are
rejected. Firefox keeps normal end-to-end HTTPS certificate verification. The
proxy neither intercepts TLS nor logs request contents. Firefox's system proxy
also routes ordinary HTTP(S) requests to that rejecting fixture. This is not
browser-wide, OS-level or DNS isolation; Firefox-protected traffic and other
protocols remain subject to platform limits.
No proxy authentication is used. A selected-route failure is not bypassed.

The exporter requires a working display, ready state, nonzero canvas, real
provider connection and all three attribution links. It fails on missing
attribution, fallback or partial state. It refuses an existing output directory
so an unsuccessful attempt cannot overwrite released assets. The new output
directory is reserved atomically. A failed attempt can leave partial candidate
images or candidate metadata if capture finished before teardown failed; neither
is evidence of a successful run. Only a successful workflow plus visual review
qualifies the artifacts for release use. Live capture owns a disposable HOME, XDG
directories, temporary directory and Firefox profile. Shutdown awaits the owned
Firefox process group and closes every fixture socket. Private working
directories are removed after verified process termination, including ordinary
setup failures. If termination cannot be verified, the run fails and retains its
owned profile rather than deleting files a live process might still use. Transient extension UUIDs are redacted
from logs and metadata without changing the actual screenshot DOM.

## Required human/visual review

`ready` alone is not proof of geographic pixels. Inspect all four PNGs before
copying any candidate into `store-assets/screenshots`:

- Exactly 1280 × 800, readable complete extension UI; any uniform picker reduction is recorded
- Fourth image shows actual recognizable geographic features and labels
- OpenFreeMap, © OpenMapTiles and Data from OpenStreetMap attribution is visible
- No fake success labels, remote-code substitutions or grid-only fallback
- No private account/credential/profile or displayed real IP
- All runtime checks remain honest; synthetic manual identity may be Partial

Metadata retains temporary unsigned-candidate provenance and source/image
hashes, including the bundled map worker. The CI artifact separately records
its exact source commit. It explicitly requires visual review. The release owner coordinates
final frozen-build recapture, version consistency, listing/privacy/caption
changes and publication. Do not modify historical release assets.

The picker image centers the complete Identity & Privacy fieldset,
including policies, map attribution, provider disclosure, status and coordinate inputs.
A bounded taller source viewport and uniform reduction (at least 75%, never enlargement)
can fit the complete picker into the store canvas. Metadata records its source box,
viewport and scale; audit stays native scale. It still fails for clipped source content
or a reduction below the readability bound. Full-size light/dark review images remain
available independently. Capture metadata also records
aggregate map/glyph request counts, returned bytes and peak pending RPCs. The temporary
API observer forwards original calls and responses unchanged, stores no URLs, IDs or
payloads, and is removed once all requests settle. A successful capture requires glyph
requests and at most eight pending map RPCs; these counters are test evidence, not
production telemetry or a claim about peak queue depth inside the renderer.
