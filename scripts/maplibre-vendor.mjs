/**
 * MapLibre 6.11.2 fixes GHSA-jrc7-96c5-q579. Its optional legacy worker-plugin
 * loader still evaluates fetched JavaScript. This extension never uses external
 * worker/RTL plugins: replace that entire loader, including import/fetch/eval,
 * with a deterministic denial before esbuild bundles the worker and local shared
 * module. No vendor file in node_modules is modified.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const MAPLIBRE_ASSET_HASHES = {
  "dist/maplibre-gl.mjs": "3f55566295583644617fe17d008a36c580414b8c71dd2e1fcff1309de6fdee5d",
  "dist/maplibre-gl-shared.mjs": "76b5f55bdee928c65d592684aaff2b913d50b6b17b0ec6334e88b09b6aa47960",
  "dist/maplibre-gl-worker-dev.mjs":
    "038458e57fe7466ef18e3411e869f6d5559f07248a342caf85fa85a8cd1f703f",
  "dist/maplibre-gl-shared-dev.mjs":
    "e69aba5bb50bac9bb2604e61a97a136c2637fc9be4b8091cc65fca0cdd73dfc6",
  "dist/maplibre-gl.css": "d8617d8421930e3fc6185365400e788c374c1a5d9fbe87999998c0bc14a202d3",
  "LICENSE.txt": "ee5fc05a0677eaf69601d2c7db0d9ecd6cc27c3abc1d0733bc9ed34707cf8ef2",
};

export function hardenMapLibreWorker(source) {
  const expected = MAPLIBRE_ASSET_HASHES["dist/maplibre-gl-worker-dev.mjs"];
  if (createHash("sha256").update(source).digest("hex") !== expected)
    throw new Error("Unreviewed MapLibre worker source; hardening patch refused.");
  const original = readFileSync(
    new URL("./vendor/maplibre-worker-loader.original.txt", import.meta.url),
    "utf8",
  ).trimEnd();
  const replacement = readFileSync(
    new URL("./vendor/maplibre-worker-loader.disabled.txt", import.meta.url),
    "utf8",
  ).trimEnd();
  if (source.split(original).length !== 2)
    throw new Error("Expected exactly one reviewed MapLibre plugin loader.");
  if (/\beval\s*\(|\bimport\s*\(|\bfetch\s*\(/.test(replacement))
    throw new Error("MapLibre loader replacement must deny all external code loading.");
  return source.replace(original, replacement);
}
