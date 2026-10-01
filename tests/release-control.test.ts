import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HISTORICAL_COMMIT,
  LISTED_110_COMMIT,
  type ReleaseChannel,
} from "../src/release/amo-policy.ts";
import { EXTENSION_ID } from "../src/release/version.ts";

interface Candidate {
  tag: string;
  commit: string;
  channel: ReleaseChannel;
  draft: boolean;
  assetName: "submission-state.json" | "release-metadata.json";
  submission: Record<string, unknown>;
  rawAsset?: string;
  downloadFails?: boolean;
}

function candidate(
  version: string,
  accepted: boolean,
  channel: ReleaseChannel = "listed",
): Candidate {
  const tag = `v${version}`;
  const commit = version.replaceAll(".", "").padEnd(40, "a");
  return {
    tag,
    commit,
    channel,
    draft: true,
    assetName: "submission-state.json",
    submission: {
      schemaVersion: 1,
      tag,
      version,
      commit,
      extensionId: EXTENSION_ID,
      channel,
      accepted,
      sourceSha256: "b".repeat(64),
      payload: { "manifest.json": "c".repeat(64) },
    },
  };
}

// These executables implement only the read commands used by select and rejected
// prepare runs. Every unexpected command fails, including any attempted mutation.
const mockCommand = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const fixture = JSON.parse(fs.readFileSync(process.env.FIXTURE_PATH, "utf8"));
const binary = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify([binary, ...args]) + "\\n");
function fail() { process.exit(1); }
function output(value) { process.stdout.write(value + "\\n"); }
if (binary === "git") {
  if (args[0] === "rev-parse" && args.length === 2) {
    if (args[1] === "HEAD") output(fixture.candidates[0].commit);
    else if (args[1] === "v1.0.0^{commit}") output(fixture.historicalCommit);
    else if (args[1] === "v1.1.0^{commit}") output(fixture.listedCommit);
    else {
      const release = fixture.candidates.find((item) => args[1] === item.tag + "^{commit}");
      if (!release) fail();
      output(release.commit);
    }
  } else if (args[0] === "show" && args.length === 2) {
    const release = fixture.candidates.find((item) => args[1] === item.tag + ":release-config.json");
    if (!release) fail();
    output(JSON.stringify({ channel: release.channel }));
  } else if (
    args.length === 4 && args[0] === "merge-base" && args[1] === "--is-ancestor" &&
    args[3] === "origin/main" && fixture.candidates.some((item) => item.commit === args[2])
  ) {
    if (fixture.nonAncestor === args[2]) fail();
  } else fail();
} else if (binary === "gh") {
  if (JSON.stringify(args) === JSON.stringify([
    "api", "--paginate", "--slurp", "repos/fixture/net-identity/releases?per_page=100"
  ])) {
    output(JSON.stringify([fixture.candidates.map((item) => ({
      tag_name: item.tag, draft: item.draft, assets: [{ name: item.assetName }]
    }))]));
  } else if (
    args.length === 8 && args[0] === "release" && args[1] === "download" &&
    args[3] === "--pattern" && args[5] === "--dir" && args[7] === "--clobber"
  ) {
    const release = fixture.candidates.find((item) => item.tag === args[2]);
    if (!release || release.downloadFails || release.assetName !== args[4]) fail();
    const value = release.assetName === "submission-state.json"
      ? release.submission : { submission: release.submission };
    fs.writeFileSync(path.join(args[6], args[4]), release.rawAsset ?? JSON.stringify(value));
  } else fail();
} else fail();
`;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function run(
  candidates: Candidate[],
  options: {
    mode?: "select" | "prepare";
    releaseTag?: string;
    selectChannel?: ReleaseChannel;
    historicalCommit?: string;
    nonAncestor?: string;
  } = {},
) {
  const directory = mkdtempSync(path.join(tmpdir(), "release-control-test-"));
  directories.push(directory);
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  for (const command of ["git", "gh"])
    writeFileSync(path.join(bin, command), mockCommand, { mode: 0o755 });
  const fixture = path.join(directory, "fixture.json");
  writeFileSync(
    fixture,
    JSON.stringify({
      candidates,
      historicalCommit: options.historicalCommit ?? HISTORICAL_COMMIT,
      listedCommit: LISTED_110_COMMIT,
      nonAncestor: options.nonAncestor,
    }),
  );
  // Selection runs from main (listed), even when the exact candidate tag is unlisted.
  writeFileSync(path.join(directory, "release-config.json"), JSON.stringify({ channel: "listed" }));
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ version: candidates[0]?.tag.slice(1) }),
  );
  mkdirSync(path.join(directory, "public"));
  writeFileSync(
    path.join(directory, "public/manifest.json"),
    JSON.stringify({
      version: candidates[0]?.tag.slice(1),
      browser_specific_settings: { gecko: { id: EXTENSION_ID } },
    }),
  );
  const networkGuard = path.join(directory, "network-guard.mjs");
  writeFileSync(
    networkGuard,
    'globalThis.fetch = () => { throw new Error("Unexpected network request in CLI test"); };\n',
  );
  const output = path.join(directory, "output.txt");
  const callLog = path.join(directory, "calls.jsonl");
  writeFileSync(output, "");
  writeFileSync(callLog, "");
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      networkGuard,
      path.resolve("scripts/release-control.mjs"),
      options.mode ?? "select",
    ],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
      // Do not inherit signing credentials, GitHub tokens, or the real git/gh PATH.
      env: {
        PATH: bin,
        HOME: directory,
        GITHUB_REPOSITORY: "fixture/net-identity",
        GITHUB_OUTPUT: output,
        FIXTURE_PATH: fixture,
        CALL_LOG: callLog,
        ...(options.releaseTag ? { RELEASE_TAG: options.releaseTag } : {}),
        ...(options.selectChannel ? { SELECT_CHANNEL: options.selectChannel } : {}),
      },
    },
  );
  const calls: unknown[] = readFileSync(callLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  return { ...result, output: readFileSync(output, "utf8"), calls };
}

function expectSelected(result: ReturnType<typeof run>, selected: Candidate) {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.output).toBe(`commit=${selected.commit}\ntag=${selected.tag}\n`);
  expect(result.stderr).toContain(`Selected ${selected.tag}`);
}

function expectRejected(result: ReturnType<typeof run>, message: string) {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.output).toBe("");
  expect(result.stderr).toContain(message);
  expect(result.stderr).not.toContain("Unexpected network request");
}

describe("release-control CLI finalizer selection", () => {
  it("skips an older unaccepted draft and selects a newer accepted draft", () => {
    const older = candidate("1.1.2", false);
    const newer = candidate("1.1.5", true);
    const result = run([newer, older]);
    expectSelected(result, newer);
    expect(result.stderr).toContain(
      `Skipping ${older.tag}: submission is not recorded as accepted; phase 1 reconciliation required`,
    );
  });

  it("outputs an empty tag and no commit when all drafts are unaccepted", () => {
    const older = candidate("1.1.2", false);
    const newer = candidate("1.1.5", false);
    const result = run([newer, older]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("tag=\n");
    expect(result.stderr).toContain(`Skipping ${older.tag}:`);
    expect(result.stderr).toContain(`Skipping ${newer.tag}:`);
    expect(result.stderr).toContain("No pending release");
  });

  it("keeps the oldest accepted pending draft selected in numeric version order", () => {
    const older = candidate("1.1.9", true);
    const newer = candidate("1.1.10", true);
    const result = run([newer, older]);
    expectSelected(result, older);
    expect(result.stderr).not.toContain("Skipping");
    expect(result.calls).not.toContainEqual(
      expect.arrayContaining(["gh", "release", "download", newer.tag]),
    );
  });

  it.each([
    ["string acceptance", { accepted: "false" }, "Invalid release submission record"],
    ["missing acceptance", { accepted: undefined }, "Invalid release submission record"],
    ["malformed payload", { payload: {} }, "Invalid submission payload hashes"],
    ["wrong commit", { commit: "d".repeat(40) }, "Draft/tag provenance mismatch"],
    ["wrong tag", { tag: "v1.1.3", version: "1.1.3" }, "Draft/tag provenance mismatch"],
    ["wrong channel", { channel: "unlisted" }, "Draft/tag provenance mismatch"],
  ])("fails closed on %s instead of skipping the record", (_name, invalid, message) => {
    const older = candidate("1.1.2", false);
    Object.assign(older.submission, invalid);
    expectRejected(run([older, candidate("1.1.5", true)]), String(message));
  });

  it("fails closed on invalid asset JSON", () => {
    const older = candidate("1.1.2", false);
    older.rawAsset = "not json";
    const result = run([older, candidate("1.1.5", true)]);
    expect(result.status).toBe(1);
    expect(result.output).toBe("");
    expect(result.stderr).not.toContain("Skipping");
  });

  it.each(["submission-state.json", "release-metadata.json"] as const)(
    "fails closed on a missing %s download after an earlier unaccepted record",
    (assetName) => {
      const older = candidate("1.1.2", false);
      const newer = candidate("1.1.5", true);
      older.assetName = assetName;
      newer.assetName = assetName;
      newer.downloadFails = true;
      const result = run([older, newer]);
      expectRejected(result, "gh operation failed");
      expect(result.stderr).toContain(`Skipping ${older.tag}:`);
      expect(result.stderr).not.toContain(`Skipping ${newer.tag}:`);
    },
  );

  it("reads and validates the submission fallback in release metadata", () => {
    const older = candidate("1.1.2", false);
    const newer = candidate("1.1.5", true);
    older.assetName = "release-metadata.json";
    newer.assetName = "release-metadata.json";
    expectSelected(run([older, newer]), newer);
  });

  it.each([undefined, "unlisted"] as const)(
    "validates unlisted provenance against its tag while main is listed (filter: %s)",
    (selectChannel) => {
      const unlisted = candidate("1.1.2", true, "unlisted");
      expectSelected(run([unlisted], { selectChannel }), unlisted);
    },
  );

  it("filters channels before checking another channel's submission", () => {
    const unlisted = candidate("1.1.2", false, "unlisted");
    unlisted.rawAsset = "not json";
    const listed = candidate("1.1.5", true);
    expectSelected(run([unlisted, listed], { selectChannel: "listed" }), listed);
  });

  it("fails closed when an unaccepted tag is not on main", () => {
    const older = candidate("1.1.2", false);
    expectRejected(
      run([older, candidate("1.1.5", true)], { nonAncestor: older.commit }),
      "git operation failed",
    );
  });

  it("fails closed when an immutable historical tag changed", () => {
    expectRejected(
      run([candidate("1.1.2", false)], { historicalCommit: "f".repeat(40) }),
      "Historical tag changed",
    );
  });

  it("still selects an explicitly requested unaccepted draft but prepare rejects it", () => {
    const draft = candidate("1.1.2", false);
    expectSelected(run([draft], { releaseTag: draft.tag }), draft);
    expectRejected(
      run([draft], { releaseTag: draft.tag, mode: "prepare" }),
      "Submission is not recorded as accepted; rerun phase 1",
    );
  });

  it("excludes public metadata releases automatically and retains explicit selection", () => {
    const published = candidate("1.1.2", true);
    published.draft = false;
    published.assetName = "release-metadata.json";
    const automatic = run([published]);
    expect(automatic.status, automatic.stderr).toBe(0);
    expect(automatic.output).toBe("tag=\n");
    const explicit = run([published], { releaseTag: published.tag });
    expectSelected(explicit, published);
    expect(explicit.calls).not.toContainEqual(
      expect.arrayContaining(["gh", "release", "download"]),
    );
  });

  it("leaves public metadata provenance validation to the explicit prepare phase", () => {
    const published = candidate("1.1.2", true);
    published.draft = false;
    published.assetName = "release-metadata.json";
    published.submission.commit = "d".repeat(40);
    expectSelected(run([published], { releaseTag: published.tag }), published);
    expectRejected(
      run([published], { releaseTag: published.tag, mode: "prepare" }),
      "Published provenance mismatch",
    );
  });
});
