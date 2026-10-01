/**
 * Checks the version that would ship.
 *
 * package.json is authoritative. The manifest and, when this is a tag build,
 * refs/tags/vX.Y.Z must match it. Pass --release to also reject a dirty tree.
 * PUBLISHED_VERSIONS is a comma-separated list of versions already shipped.
 *
 * Usage:
 *   node --experimental-strip-types src/release/check-version.ts [--release]
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertAmoMetadata } from "./amo-metadata.ts";
import { checkReleaseVersion } from "./version.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireClean = process.argv.includes("--release");

try {
  assertAmoMetadata(JSON.parse(readFileSync(path.join(root, "amo-metadata.json"), "utf8")));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid AMO metadata");
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  version?: string;
};
const manifest = JSON.parse(readFileSync(path.join(root, "public", "manifest.json"), "utf8")) as {
  version?: string;
  browser_specific_settings?: { gecko?: { id?: string } };
};

const tag = process.env.GITHUB_REF?.startsWith("refs/tags/")
  ? process.env.GITHUB_REF.slice("refs/tags/".length)
  : null;

const previousVersions = (process.env.PUBLISHED_VERSIONS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry !== "");

const result = checkReleaseVersion({
  packageVersion: packageJson.version ?? "",
  manifestVersion: manifest.version ?? "",
  extensionId: manifest.browser_specific_settings?.gecko?.id ?? "",
  tag,
  previousVersions,
  dirty: worktreeIsDirty(root),
  requireClean,
});

if (!result.ok) {
  console.error(result.errors.join("\n"));
  process.exit(1);
}

console.error(`version ${result.version} matches the manifest and extension id`);

function worktreeIsDirty(directory: string): boolean {
  try {
    return execSync("git status --porcelain", { cwd: directory, encoding: "utf8" }).trim() !== "";
  } catch {
    return true;
  }
}
