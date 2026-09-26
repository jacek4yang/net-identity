/**
 * Build script.
 *
 * Deliberately small and linear: clean `dist/`, bundle the five entry points,
 * copy the static assets, then verify that every path the manifest references
 * actually exists. That last step turns a whole class of "the extension loads but
 * does nothing" bugs into a build failure.
 *
 * Usage:
 *   node scripts/build.mjs               development build (source maps, no minify)
 *   node scripts/build.mjs --production  packaging build (minified, no source maps)
 */
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const production = process.argv.includes("--production");

/** Entry point -> output path relative to `dist`. */
const ENTRIES = {
  background: "src/background/index.ts",
  "content/bridge": "src/content/bridge.ts",
  "content/page-shim": "src/content/page-shim.ts",
  "popup/popup": "src/popup/popup.ts",
  "options/options": "src/options/options.ts",
};

/** Content scripts are classic scripts, not modules. */
const IIFE_ENTRIES = new Set(["content/bridge", "content/page-shim"]);

const STATIC_FILES = [
  "public/manifest.json",
  "public/icons",
  "src/popup/popup.html",
  "src/popup/popup.css",
  "src/options/options.html",
  "src/options/options.css",
];

async function copyStatic() {
  await cp(path.join(root, "public", "manifest.json"), path.join(dist, "manifest.json"));
  await cp(path.join(root, "public", "icons"), path.join(dist, "icons"), { recursive: true });
  await mkdir(path.join(dist, "popup"), { recursive: true });
  await mkdir(path.join(dist, "options"), { recursive: true });
  await cp(path.join(root, "src/popup/popup.html"), path.join(dist, "popup/popup.html"));
  await cp(path.join(root, "src/popup/popup.css"), path.join(dist, "popup/popup.css"));
  await cp(path.join(root, "src/options/options.html"), path.join(dist, "options/options.html"));
  await cp(path.join(root, "src/options/options.css"), path.join(dist, "options/options.css"));
}

async function bundle() {
  const esmEntryPoints = Object.entries(ENTRIES)
    .filter(([name]) => !IIFE_ENTRIES.has(name))
    .map(([name, source]) => [name, source]);
  const iifeEntryPoints = Object.entries(ENTRIES)
    .filter(([name]) => IIFE_ENTRIES.has(name))
    .map(([name, source]) => [name, source]);

  const common = {
    bundle: true,
    target: ["firefox128"],
    platform: "browser",
    logLevel: "info",
    outdir: dist,
    absWorkingDir: root,
    minify: production,
    sourcemap: production ? false : "linked",
    legalComments: "none",
    charset: "utf8",
  };

  await Promise.all([
    build({ ...common, entryPoints: Object.fromEntries(esmEntryPoints), format: "esm" }),
    build({ ...common, entryPoints: Object.fromEntries(iifeEntryPoints), format: "iife" }),
  ]);
}

/** Fails the build when the manifest points at something that was not emitted. */
async function verifyDist() {
  const manifestPath = path.join(dist, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const referenced = new Set();

  for (const script of manifest.background?.scripts ?? []) referenced.add(script);
  if (manifest.action?.default_popup) referenced.add(manifest.action.default_popup);
  if (manifest.options_ui?.page) referenced.add(manifest.options_ui.page);
  for (const entry of Object.values(manifest.icons ?? {})) referenced.add(entry);
  for (const entry of Object.values(manifest.action?.default_icon ?? {})) referenced.add(entry);
  for (const script of manifest.content_scripts ?? []) {
    for (const file of script.js ?? []) referenced.add(file);
  }

  const missing = [];
  for (const relative of referenced) {
    try {
      await stat(path.join(dist, relative));
    } catch {
      missing.push(relative);
    }
  }

  if (missing.length > 0) {
    throw new Error(`manifest references missing files: ${missing.join(", ")}`);
  }

  const script = path.join(dist, "background.js");
  const contents = await readFile(script, "utf8");
  if (/\beval\s*\(/.test(contents) || /new\s+Function\s*\(/.test(contents)) {
    throw new Error("background bundle contains eval/new Function");
  }
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await bundle();
  await copyStatic();
  await verifyDist();
  console.error(
    `built ${Object.keys(ENTRIES).length} entry points and copied ${STATIC_FILES.length} static paths into dist/ (${
      production ? "production" : "development"
    })`,
  );
}

main().catch((error) => {
  console.error(`build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
