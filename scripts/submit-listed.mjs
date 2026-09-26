/**
 * Submits dist/ to addons.mozilla.org as a listed add-on.
 *
 * The tag workflow is the only caller. Credentials come from WEB_EXT_API_KEY and
 * WEB_EXT_API_SECRET, which that workflow sets from the AMO_JWT_ISSUER and
 * AMO_JWT_SECRET repository secrets. This script never prints them.
 *
 * A version AMO already has is treated as success, so rerunning a tag workflow does
 * not create a second submission. Submission success is not approval: Mozilla reviews
 * listed versions asynchronously.
 *
 * Usage:
 *   node scripts/submit-listed.mjs --source-dir dist --source-code source.zip
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
  console.error(
    "AMO_JWT_ISSUER and AMO_JWT_SECRET must be repository Actions secrets. They are read only by the tag workflow.",
  );
  process.exit(1);
}

const sourceDir = argument("--source-dir", path.join(root, "dist"));
const sourceCode = argument("--source-code", "");
const webExt = path.join(root, "node_modules", "web-ext", "bin", "web-ext.js");
const args = [
  webExt,
  "sign",
  "--source-dir",
  sourceDir,
  "--artifacts-dir",
  path.join(root, "web-ext-artifacts"),
  "--channel=listed",
  "--amo-metadata",
  path.join(root, "amo-metadata.json"),
  "--approval-timeout",
  "0",
  "--no-input",
];
if (sourceCode !== "") args.push("--upload-source-code", sourceCode);

const result = spawnSync(process.execPath, args, {
  cwd: root,
  encoding: "utf8",
  env: process.env,
});
const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
if (result.status === 0) {
  console.error(
    "AMO accepted the listed submission. Public listing still waits for Mozilla review.",
  );
  process.exit(0);
}
if (/already exists|version already exists|duplicate version/i.test(output)) {
  console.error("AMO already has this version. Not submitting it again.");
  process.exit(0);
}
console.error(output);
process.exit(result.status ?? 1);
