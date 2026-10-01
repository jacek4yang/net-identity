# MapLibre worker hardening

This source-only patch is for the pinned official npm package `maplibre-gl@6.11.2`.
Upstream source: <https://github.com/maplibre/maplibre-gl-js/tree/v6.11.2>.
The adjacent original function is copied verbatim from
`dist/maplibre-gl-worker-dev.mjs`, under the adjacent upstream BSD/third-party
licence notice. These patch files and test fixtures do not ship in the extension.

The latest package includes the fix for
[GHSA-jrc7-96c5-q579](https://github.com/maplibre/maplibre-gl-js/security/advisories/GHSA-jrc7-96c5-q579).
The old 5.x candidate is not the approved dependency. We continue to disable the
attribution control and render our own fixed attribution links as text.

Upstream's optional external worker/RTL-plugin loader can import modules, fetch
classic JavaScript and evaluate it. net-identity does not use those plugins and
cannot permit remote code or evaluation. At build time, `maplibre-vendor.mjs`:

1. Verifies the exact upstream worker SHA-256 and all other emitted vendor inputs
2. Requires exactly one complete match for the reviewed original loader function
3. Replaces the whole loader with a function that always throws, for every URL
4. Bundles that worker with its local shared module into one extension-local asset
5. Runs the unchanged all-shipped-script no-eval/remote-code scan and strict linter

The patch never rewrites `node_modules`, silently accepts a different release, or
only removes one dangerous statement while preserving another loading path. Tests
reject modified/duplicate inputs and execute the deny function with classic,
module, blob and extension URLs. Browser map tests must verify the packaged worker
under the actual extension CSP. No CSP relaxation or vendor-warning exception is
part of this patch.
