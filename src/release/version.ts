/**
 * Release-version rules.
 *
 * package.json is the version that must ship. A tag, the manifest, and any
 * previously published version have to agree with it. The extension id does
 * not change. Release notes are built only from pull-request titles that the
 * caller supplies.
 */

export const EXTENSION_ID = "net-identity@jacek4yang.github.io";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

export interface ReleaseCheckInput {
  packageVersion: string;
  manifestVersion: string;
  extensionId: string;
  tag?: string | null;
  previousVersions?: readonly string[];
  dirty?: boolean;
  requireClean?: boolean;
}

export type ReleaseCheck = { ok: true; version: string } | { ok: false; errors: string[] };

export function parseSemver(value: string): Semver | null {
  const match = SEMVER.exec(value);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) return null;
  return { major, minor, patch };
}

export function compareSemver(left: Semver, right: Semver): -1 | 0 | 1 {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return 0;
}

export function versionFromTag(tag: string): Semver | null {
  if (!tag.startsWith("v")) return null;
  return parseSemver(tag.slice(1));
}

export function checkReleaseVersion(input: ReleaseCheckInput): ReleaseCheck {
  const errors: string[] = [];
  const version = parseSemver(input.packageVersion);
  if (version === null) errors.push("package version must be major.minor.patch");
  if (input.manifestVersion !== input.packageVersion) {
    errors.push(
      `manifest version ${input.manifestVersion} must match package.json ${input.packageVersion}`,
    );
  }
  if (input.extensionId !== EXTENSION_ID) {
    errors.push(`extension id must stay ${EXTENSION_ID}`);
  }
  if (input.requireClean === true && input.dirty === true) {
    errors.push("the worktree is dirty");
  }
  if (input.tag !== undefined && input.tag !== null && input.tag !== "") {
    if (versionFromTag(input.tag) === null || input.tag !== `v${input.packageVersion}`) {
      errors.push(`tag ${input.tag} must be v${input.packageVersion}`);
    }
  }
  for (const previous of input.previousVersions ?? []) {
    const published = parseSemver(previous);
    if (published === null || version === null) {
      errors.push(`published version ${previous} is not major.minor.patch`);
      continue;
    }
    const order = compareSemver(version, published);
    if (order === 0) errors.push(`version ${input.packageVersion} is already published`);
    if (order < 0) {
      errors.push(`version ${input.packageVersion} is older than published ${previous}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, version: input.packageVersion };
}

export interface ReleasePullRequest {
  number: number;
  title: string;
}

/** Notes contain only the supplied pull requests. An empty list does not invent changes. */
export function formatReleaseNotes(pulls: readonly ReleasePullRequest[]): string {
  if (pulls.length === 0) return "No pull requests were provided for these notes.\n";
  const lines = pulls.map((pull) => {
    if (!Number.isInteger(pull.number) || pull.number < 1 || pull.title.trim() === "") {
      throw new Error("a release note entry needs a pull request number and title");
    }
    return `- #${pull.number} ${pull.title}`;
  });
  return `${lines.join("\n")}\n`;
}
