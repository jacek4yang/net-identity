/**
 * Writes `SHA256SUMS.txt` and `release-metadata.json` for the artifacts supplied on
 * the command line. The tag workflow runs this after packaging, before it publishes
 * the GitHub Release.
 *
 * The tag and commit come from GITHUB_REF_NAME and GITHUB_SHA, which the workflow sets.
 *
 * Usage:
 *   node --experimental-strip-types src/release/write-metadata.ts artifacts/*.zip source.zip
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReleaseMetadata, formatChecksums, RELEASE_NAME } from "./metadata.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: write-metadata.ts <artifact> [artifact ...]");
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  version?: string;
};
const version = packageJson.version ?? "";
const tag = process.env.GITHUB_REF_NAME ?? `v${version}`;
const commit = process.env.GITHUB_SHA ?? "";

const artifacts = files.map((file) => ({
  name: path.basename(file),
  sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
}));

const metadata = buildReleaseMetadata({
  version,
  tag,
  commit,
  channel: "listed",
  artifacts,
});

writeFileSync(path.join(root, "release-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
writeFileSync(path.join(root, "SHA256SUMS.txt"), formatChecksums(metadata.artifacts));
console.error(`${RELEASE_NAME} ${version}: wrote release-metadata.json and SHA256SUMS.txt`);
