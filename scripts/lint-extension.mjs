/**
 * Extension lint (`web-ext lint`) with a precise failure policy.
 *
 * `--warnings-as-errors` is too blunt: two of the possible warnings are inherent
 * to choices this project makes deliberately, and blanket-ignoring warnings would
 * hide real packaging mistakes. So:
 *
 *   - every error fails the run
 *   - every warning fails the run, unless it is listed below with a justification
 *
 * Usage: node scripts/lint-extension.mjs [--source-dir dist]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import webext from "web-ext";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sourceDirArgumentIndex = process.argv.indexOf("--source-dir");
const sourceDir = path.resolve(
  root,
  sourceDirArgumentIndex === -1 ? "dist" : (process.argv[sourceDirArgumentIndex + 1] ?? "dist"),
);

/**
 * Warnings that are expected and understood. Matching on both the code and a
 * fragment of the description keeps the exemption narrow: a different manifest key
 * that triggers the same generic code still fails the build.
 */
const ALLOWED_WARNINGS = [
  {
    code: "KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION",
    descriptionIncludes: "data_collection_permissions",
    reason:
      "Desktop strict_min_version is 140, which satisfies Firefox's built-in data-consent floor. Firefox for Android's floor for the same key is 142, and this project does not ship an Android build.",
  },
];

function isAllowed(warning) {
  const description = typeof warning.description === "string" ? warning.description : "";
  return ALLOWED_WARNINGS.find(
    (allowed) => allowed.code === warning.code && description.includes(allowed.descriptionIncludes),
  );
}

function formatIssue(issue) {
  const location = issue.file === undefined ? "" : ` (${issue.file})`;
  return `${issue.code}${location}: ${issue.description ?? issue.message}`;
}

// Sanity check: the manifest that is about to be linted should be the built one.
const manifestPath = path.join(sourceDir, "manifest.json");
try {
  await readFile(manifestPath, "utf8");
} catch {
  console.error(
    `lint failed: ${path.relative(root, manifestPath)} not found. Run \`npm run build\` first.`,
  );
  process.exit(1);
}

const result = await webext.cmd.lint(
  { sourceDir, warningsAsErrors: false, output: "none" },
  { shouldExitProgram: false },
);

const errors = result.errors ?? [];
const warnings = result.warnings ?? [];
const notices = result.notices ?? [];

for (const error of errors) console.error(`error   ${formatIssue(error)}`);

const unexpectedWarnings = [];
for (const warning of warnings) {
  const allowed = isAllowed(warning);
  if (allowed === undefined) {
    unexpectedWarnings.push(warning);
    console.error(`warning ${formatIssue(warning)}`);
  } else {
    console.error(`warning (allowed) ${warning.code}: ${allowed.reason}`);
  }
}

if (errors.length > 0) {
  console.error(`\nextension lint failed: ${errors.length} error(s)`);
  process.exit(1);
}

if (unexpectedWarnings.length > 0) {
  console.error(
    `\nextension lint failed: ${unexpectedWarnings.length} unexpected warning(s). ` +
      "Fix them, or add a justified entry to ALLOWED_WARNINGS in scripts/lint-extension.mjs.",
  );
  process.exit(1);
}

console.error(
  `extension lint passed: 0 errors, ${warnings.length} warning(s) (${warnings.length} allowed), ${notices.length} notice(s)`,
);
