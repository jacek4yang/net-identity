/**
 * Verifies the packaged extension produced by `web-ext build`.
 *
 * The packaging step is the last chance to notice that tests, sources, build
 * configuration or stray scratch files were bundled into a release. Node has no
 * built-in zip reader, so the central directory is parsed here directly — enough
 * to list entry names without adding a dependency.
 *
 * Usage: node scripts/verify-artifacts.mjs [--artifacts-dir artifacts]
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directoryArgument = process.argv.indexOf("--artifacts-dir");
const artifactsDir = path.resolve(
  root,
  directoryArgument === -1 ? "artifacts" : (process.argv[directoryArgument + 1] ?? "artifacts"),
);

/** Paths that must be present in a shippable package. */
const REQUIRED_ENTRIES = [
  "manifest.json",
  "background.js",
  "content/bridge.js",
  "content/page-shim.js",
  "popup/popup.html",
  "popup/popup.js",
  "popup/popup.css",
  "options/options.html",
  "options/options.js",
  "options/options.css",
  "options/maplibre.css",
  "options/maplibre.js",
  "options/maplibre-worker.js",
  "licenses/maplibre-LICENSE.txt",
  "licenses/maplibre-dependencies.txt",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-64.png",
  "icons/icon-48.png",
  "icons/icon-96.png",
  "icons/icon-128.png",
];

/** Paths that must never ship. */
const FORBIDDEN_PATTERNS = [
  // Test TLS trust material must never become a shipped extension asset.
  /\.(?:pem|key|crt|cer|p12|pfx|csr|srl)$/i,
  /(^|\/)store-assets\//,
  /(^|\/)docs\//,
  /\.svg$/,
  /(^|\/)node_modules\//,
  /(^|\/)tests?\//,
  /(^|\/)src\//,
  /(^|\/)scripts\//,
  /(^|\/)\.git\//,
  /(^|\/)\.env/,
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)tsconfig\.json$/,
  /(^|\/)eslint\.config\.js$/,
  /(^|\/)prettier\.config\.mjs$/,
  /\.map$/,
  /\.ts$/,
  /(^|\/)AGENTS\.md$/,
  /(^|\/)CONTRIBUTING\.md$/,
];

function readCentralDirectoryNames(buffer) {
  const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
  let eocd = -1;
  for (
    let index = buffer.length - 22;
    index >= 0 && index >= buffer.length - 22 - 65535;
    index -= 1
  ) {
    if (buffer.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY) {
      eocd = index;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a zip file (end of central directory not found)");

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const names = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`corrupt zip: bad central directory header at ${offset}`);
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.toString("utf8", offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

async function newestArchive() {
  let entries;
  try {
    entries = await readdir(artifactsDir);
  } catch {
    throw new Error(
      `${path.relative(root, artifactsDir)} does not exist; run \`npm run package\` first`,
    );
  }

  const archives = [];
  for (const entry of entries) {
    if (!entry.endsWith(".zip")) continue;
    const fullPath = path.join(artifactsDir, entry);
    archives.push({ fullPath, modified: (await stat(fullPath)).mtimeMs });
  }
  if (archives.length === 0)
    throw new Error(`no .zip found in ${path.relative(root, artifactsDir)}`);

  archives.sort((left, right) => right.modified - left.modified);
  const newest = archives[0];
  if (newest === undefined) throw new Error("no archive found");
  return newest;
}

const archive = await newestArchive();
const names = readCentralDirectoryNames(await readFile(archive.fullPath));
const nameSet = new Set(names);

const missing = REQUIRED_ENTRIES.filter((entry) => !nameSet.has(entry));
const forbidden = names.filter((name) => FORBIDDEN_PATTERNS.some((pattern) => pattern.test(name)));

if (missing.length > 0) {
  console.error(`package verification failed: missing ${missing.join(", ")}`);
  process.exit(1);
}

if (forbidden.length > 0) {
  console.error(
    `package verification failed: unexpected files in the archive:\n  ${forbidden.join("\n  ")}`,
  );
  process.exit(1);
}

const { size } = await stat(archive.fullPath);
console.error(
  `package verified: ${path.relative(root, archive.fullPath)} (${names.length} entries, ${(size / 1024).toFixed(1)} KiB)`,
);
