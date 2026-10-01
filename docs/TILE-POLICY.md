# Location picker and tile policy

## 1.1.5 candidate: unreleased MapLibre + OpenFreeMap integration

The real basemap is an explicit source change after the released **1.1.3** offline
picker. Historical tags, signed packages and listing assets are not rewritten.

OpenFreeMap explicitly provides a public service for websites and mobile applications;
its [quick start](https://openfreemap.org/quick_start/) specifies MapLibre GL JS with
`https://tiles.openfreemap.org/styles/liberty`. It needs no API key. The service is
used under its [terms](https://openfreemap.org/tos/) and [privacy policy](https://openfreemap.org/privacy/),
with no availability SLA. It is not the standard `tile.openstreetmap.org` service.

### Data and activation

- The grid and typed coordinates work offline. Online data loads only after the
  visible **Load online map** action for the current editor session.
- MapLibre code, CSS, worker and required license notices ship locally. Remote
  styles, tile metadata, vector/raster tiles, sprites and glyphs are data, not scripts.
- CJK ideographs use the style's provider glyphs (`localIdeographFontFamily: false`),
  rather than assuming the operating system has an appropriate CJK font. This can
  request more glyph ranges, still only after explicit map enablement.
- Only validated HTTPS paths at `tiles.openfreemap.org` are permitted. Current
  resources include Liberty styles, `/planet` metadata and its versioned vector tiles,
  Natural Earth raster tiles, revisioned sprites, and font glyph ranges. Weekly tile
  revisions are validated rather than hard-coded to one date.
- A background broker bounds sessions, in-flight work, byte sizes and deadlines.
  Fetches omit cookies/origin credentials/referrer and reject redirects. There is no
  spoofed Referer, remote plugin import or arbitrary URL/HTTP proxy endpoint.
- A renderer-side FIFO admits at most 8 broker requests and 256 waiting URL/control
  records, with a 60-second queue-inclusive deadline. It stores no response-byte
  cache, cancels on removal and never retries. An aborted active request retains its
  slot until the broker RPC settles. Existing broker/network/byte limits are unchanged.
  Glyph failures are reported directly because the renderer may otherwise substitute
  an unavailable local font silently; a later load event cannot erase that warning.
- The active route remains authoritative. A failed proxy is never retried through
  Direct. Provider-host bypass rules prevent map activation rather than being overridden.
  Direct/Off additionally requires the existing optional personal-data consent.
- Route changes, editor closure, permission revocation and background restart invalidate
  map authorization; they cannot resurrect it from stored profiles. A failed map load
  never applies a profile or changes location/timezone/WebRTC identity by itself.

### Disclosure and attribution

Tile requests reveal the viewed map region and network-visible IP to OpenFreeMap and
its delivery infrastructure, including Cloudflare. No separate marker/profile upload
occurs, but the viewed region must not be described as secret. The provider describes
anonymized metadata logging and limited security-incident IP retention in its policy;
no claim of zero third-party collection is made.

Visible imagery carries linked **OpenFreeMap**, **© OpenMapTiles** and **Data from
OpenStreetMap** attribution. The renderer is pinned MapLibre GL JS 6.11.2 under BSD-3-Clause, with
its bundled dependency notices retained. [OpenFreeMap's license inventory](https://github.com/hyperknot/openfreemap/blob/main/LICENSE.md)
identifies OpenFreeMap code (MIT), Liberty style code (BSD-3-Clause) and design
(CC-BY-4.0), Noto fonts (SIL OFL), and Natural Earth data (public domain). OpenStreetMap
data attribution links its copyright page. Do not strip attribution from screenshots.

The pinned version includes upstream's attribution-sanitizer security fix. Its optional
external-plugin loader is replaced by a verified fail-closed stub during the reproducible
build; no remote plugin or `eval` exception is introduced. See the precise source-hash,
single-match and reviewer rationale in `docs/AMO-REVIEW.md`.

## Historical offline-only decision

On 2026-09-27 the project rejected direct use of the standard
[OpenStreetMap raster tile service](https://operations.osmfoundation.org/policies/tiles/):
its identification/referrer requirements were not established for extension pages, and
inventing a website origin was not acceptable. The replacement `NO_TILES` grid made no
network requests and carried the truthful label “Local coordinate grid · No map imagery”.
Its independent viewport/selection/gesture model fixed hidden-editor downloads, retry
storms, pointer cancellation and returning-drag misclassification. Those interaction
fixes are preserved; the new provider decision does not authorize the rejected service
or a Referer workaround.
