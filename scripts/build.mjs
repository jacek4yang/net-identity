/**
 * Build script.
 *
 * Deliberately small and linear: clean `dist/`, bundle the application, vendor and worker entry points,
 * copy the static assets, then verify that every path the manifest references
 * actually exists. That last step turns a whole class of "the extension loads but
 * does nothing" bugs into a build failure.
 *
 * Usage:
 *   node scripts/build.mjs               development build (source maps, no minify)
 *   node scripts/build.mjs --production  packaging build (minified, no source maps)
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { hardenMapLibreWorker, MAPLIBRE_ASSET_HASHES } from "./maplibre-vendor.mjs";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  "options/maplibre": "src/vendor/maplibre.ts",
  "options/maplibre-worker": "node_modules/maplibre-gl/dist/maplibre-gl-worker-dev.mjs",
};

/** Content scripts are classic scripts, not modules. */
const IIFE_ENTRIES = new Set(["content/bridge", "content/page-shim", "options/maplibre-worker"]);

const STATIC_FILES = [
  "public/manifest.json",
  "public/icons",
  "src/popup/popup.html",
  "src/popup/popup.css",
  "src/options/options.html",
  "src/options/options.css",
];

/** Source hashes bind every bundled vendor input to the reviewed, patched npm release. */

async function verifyMapLibreVendor() {
  for (const [asset, expected] of Object.entries(MAPLIBRE_ASSET_HASHES)) {
    const bytes = await readFile(path.join(root, "node_modules/maplibre-gl", asset));
    if (createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new Error(
        `Unreviewed MapLibre asset ${asset}; update hashes only after source/security/licence review.`,
      );
  }
}

async function copyStatic() {
  await cp(path.join(root, "public", "manifest.json"), path.join(dist, "manifest.json"));
  await cp(path.join(root, "public", "icons"), path.join(dist, "icons"), { recursive: true });
  await mkdir(path.join(dist, "popup"), { recursive: true });
  await mkdir(path.join(dist, "options"), { recursive: true });
  await cp(path.join(root, "src/popup/popup.html"), path.join(dist, "popup/popup.html"));
  await cp(path.join(root, "src/popup/popup.css"), path.join(dist, "popup/popup.css"));
  await cp(path.join(root, "src/options/options.html"), path.join(dist, "options/options.html"));
  await cp(path.join(root, "src/options/options.css"), path.join(dist, "options/options.css"));
  const maplibre = path.join(root, "node_modules/maplibre-gl");
  const metadata = JSON.parse(await readFile(path.join(maplibre, "package.json"), "utf8"));
  if (metadata.version !== "6.11.2")
    throw new Error("Review MapLibre CSP/worker/licences before changing the pinned version.");
  await cp(path.join(maplibre, "dist/maplibre-gl.css"), path.join(dist, "options/maplibre.css"));
  await mkdir(path.join(dist, "licenses"), { recursive: true });
  await cp(path.join(maplibre, "LICENSE.txt"), path.join(dist, "licenses/maplibre-LICENSE.txt"));
  await copyMapLicenses();
}

/** Include the licences of the pinned renderer's transitive runtime dependencies. */
async function copyMapLicenses() {
  const seen = new Set();
  const sections = [];
  async function visit(packageDir) {
    const metadata = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
    const key = `${metadata.name}@${metadata.version}`;
    if (seen.has(key)) return;
    seen.add(key);
    const files = (await readdir(packageDir))
      .filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name))
      .sort();
    // This package carries its complete MIT licence in README, not a LICENSE file.
    if (key === "murmurhash-js@1.0.0" && files.length === 0) files.push("README.md");
    if (files.length === 0) throw new Error(`Missing licence for ${key}`);
    sections.push(`\n${"=".repeat(72)}\n${key} (${metadata.license ?? "see below"})\n`);
    for (const file of files) {
      if ((await stat(path.join(packageDir, file))).isFile())
        sections.push(await readFile(path.join(packageDir, file), "utf8"));
    }
    for (const name of Object.keys(metadata.dependencies ?? {}).sort()) {
      let parent = packageDir;
      while (true) {
        const candidate = path.join(parent, "node_modules", name);
        try {
          await stat(path.join(candidate, "package.json"));
          await visit(candidate);
          break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          const next = path.dirname(parent);
          if (next === parent) throw new Error(`Missing dependency ${name}`, { cause: error });
          parent = next;
        }
      }
    }
  }
  await visit(path.join(root, "node_modules/maplibre-gl"));
  await writeFile(path.join(dist, "licenses/maplibre-dependencies.txt"), sections.join("\n"));
}

async function bundle() {
  const esmEntryPoints = Object.entries(ENTRIES)
    .filter(([name]) => !IIFE_ENTRIES.has(name) && name !== "options/maplibre")
    .map(([name, source]) => [name, source]);
  const iifeEntryPoints = Object.entries(ENTRIES)
    .filter(([name]) => IIFE_ENTRIES.has(name))
    .map(([name, source]) => [name, source]);

  const common = {
    bundle: true,
    target: ["firefox140"],
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
    build({
      ...common,
      entryPoints: Object.fromEntries(esmEntryPoints),
      format: "esm",
      plugins: [
        {
          name: "local-maplibre-vendor",
          setup(build) {
            build.onResolve({ filter: /^maplibre-gl$/ }, () => ({
              path: "./maplibre.js",
              external: true,
            }));
          },
        },
      ],
    }),
    build({
      ...common,
      entryPoints: { "options/maplibre": ENTRIES["options/maplibre"] },
      format: "esm",
    }),
    build({
      ...common,
      entryPoints: Object.fromEntries(iifeEntryPoints),
      format: "iife",
      plugins: [
        {
          name: "disable-external-maplibre-worker-plugins",
          setup(build) {
            build.onLoad({ filter: /maplibre-gl-worker-dev\.mjs$/ }, async (args) => ({
              contents: hardenMapLibreWorker(await readFile(args.path, "utf8")),
              loader: "js",
              resolveDir: path.dirname(args.path),
            }));
          },
        },
      ],
    }),
  ]);
}

/** The packaged manifest version is taken from package.json, and the id is fixed. */
async function assertShippedVersion() {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const manifestPath = path.join(dist, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== packageJson.version) {
    throw new Error(
      `manifest version ${manifest.version} must match package.json ${packageJson.version}`,
    );
  }
  const extensionId = manifest.browser_specific_settings?.gecko?.id;
  if (extensionId !== "net-identity@jacek4yang.github.io") {
    throw new Error("extension id must stay net-identity@jacek4yang.github.io");
  }
  manifest.version = packageJson.version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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

  const bundled = await readdir(dist, { recursive: true });
  for (const entry of bundled) {
    const relative = String(entry);
    if (relative.endsWith(".css")) {
      const css = await readFile(path.join(dist, relative), "utf8");
      if (/@import\b|url\(\s*["']?https?:/i.test(css))
        throw new Error(`${relative} loads remote styles or images`);
    }
    if (!relative.endsWith(".js") && !relative.endsWith(".html")) continue;
    const contents = await readFile(path.join(dist, relative), "utf8");
    if (/\beval\s*\(/.test(contents) || /new\s+Function\s*\(/.test(contents)) {
      throw new Error(`${relative} contains eval/new Function`);
    }
    if (/<script\b[^>]*\bsrc\s*=\s*["']https?:/i.test(contents)) {
      throw new Error(`${relative} loads a remote script`);
    }
    if (/\bimport\s*\(\s*["']https?:/.test(contents)) {
      throw new Error(`${relative} imports remote code`);
    }
  }
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await verifyMapLibreVendor();
  await bundle();
  await copyStatic();
  await assertShippedVersion();
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
