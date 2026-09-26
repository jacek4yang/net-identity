/**
 * Writes `release.md` from `pulls.json`, which the tag workflow produces with
 * `gh pr list --state merged --base main --json number,title`.
 *
 * Only the supplied pull requests appear. Entries that are not a number/title pair are
 * dropped rather than invented.
 *
 * Usage:
 *   node --experimental-strip-types src/release/write-notes.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatGithubReleaseBody, type ReleasePullRequest } from "./version.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const raw = JSON.parse(readFileSync(path.join(root, "pulls.json"), "utf8")) as unknown;
const pulls: ReleasePullRequest[] = [];
if (Array.isArray(raw)) {
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { number?: unknown; title?: unknown };
    if (typeof record.number !== "number" || typeof record.title !== "string") continue;
    if (record.title.trim() === "") continue;
    pulls.push({ number: record.number, title: record.title });
  }
}
writeFileSync(path.join(root, "release.md"), formatGithubReleaseBody(pulls));
