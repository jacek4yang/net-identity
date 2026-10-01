/** Trusted tag/main orchestration; all AMO requests use API v5. No raw child output. */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { amoGet } from "../src/release/amo-api.ts";
import {
  amoState,
  ensureSubmission,
  releaseVersion,
  HISTORICAL_COMMIT,
  LISTED_110_COMMIT,
  releaseChannel,
} from "../src/release/amo-policy.ts";
import {
  parseSubmission,
  sameSubmission,
  distributionMetadata,
} from "../src/release/distribution.ts";
import { downloadSigned, sha256 } from "../src/release/download.ts";
import { payloadHashes, verifySignedPayload } from "../src/release/xpi.ts";
import { formatChecksums } from "../src/release/metadata.ts";
import { EXTENSION_ID, formatGithubReleaseBody } from "../src/release/version.ts";

const directory = "artifacts/release";
mkdirSync(directory, { recursive: true });
const file = (name) => path.join(directory, name);
const json = (name) => JSON.parse(readFileSync(file(name), "utf8"));
const write = (name, value) => writeFileSync(file(name), JSON.stringify(value, null, 2) + "\n");
function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4_000_000,
    ...options,
  });
  if (result.status !== 0)
    throw new Error(`${binary} operation failed (exit ${result.status ?? "unavailable"})`);
  return result.stdout.trim();
}
const git = (...args) => command("git", args);
const gh = (...args) => command("gh", args);
const releases = () =>
  JSON.parse(
    gh(
      "api",
      "--paginate",
      "--slurp",
      `repos/${process.env.GITHUB_REPOSITORY}/releases?per_page=100`,
    ),
  ).flat();
const lookup = (tag) => releases().find((release) => release.tag_name === tag);
const download = (tag, name) =>
  gh("release", "download", tag, "--pattern", name, "--dir", directory, "--clobber");
const upload = (tag, names) => gh("release", "upload", tag, ...names.map(file), "--clobber");
const channel = releaseChannel(
  existsSync("release-config.json")
    ? JSON.parse(readFileSync("release-config.json", "utf8"))
    : null,
);
const query = async (version) =>
  amoState(await amoGet(""), await amoGet(`versions/v${version}/`), version, channel);
function verifyHistoricalTags() {
  if (
    git("rev-parse", "v1.0.0^{commit}") !== HISTORICAL_COMMIT ||
    git("rev-parse", "v1.1.0^{commit}") !== LISTED_110_COMMIT
  )
    throw new Error("Historical tag changed");
}
function exactTag(tag) {
  const version = releaseVersion(tag);
  verifyHistoricalTags();
  const commit = git("rev-parse", `${tag}^{commit}`);
  if (git("rev-parse", "HEAD") !== commit) throw new Error("Checkout must be the exact tag");
  git("merge-base", "--is-ancestor", commit, "origin/main");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8"));
  if (
    pkg.version !== version ||
    manifest.version !== version ||
    manifest.browser_specific_settings?.gecko?.id !== EXTENSION_ID
  )
    throw new Error("Tag/package/manifest mismatch");
  return { version, commit };
}
function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
function readPending(tag, commit, expectedChannel = channel) {
  const hasState = lookup(tag)?.assets.some((asset) => asset.name === "submission-state.json");
  download(tag, hasState ? "submission-state.json" : "release-metadata.json");
  const submission = parseSubmission(
    hasState ? json("submission-state.json") : json("release-metadata.json").submission,
  );
  if (
    submission.tag !== tag ||
    submission.commit !== commit ||
    submission.channel !== expectedChannel
  )
    throw new Error("Draft/tag provenance mismatch");
  return submission;
}

async function verifyPublished(tag, version, commit, release) {
  download(tag, "release-metadata.json");
  const metadata = json("release-metadata.json");
  const submission = parseSubmission(metadata.submission);
  if (submission.tag !== tag || submission.commit !== commit)
    throw new Error("Published provenance mismatch");
  const publishedXpi = `net-identity-${version}-firefox-signed.xpi`;
  download(tag, publishedXpi);
  const payloadVerification = verifySignedPayload(
    readFileSync(file(publishedXpi)),
    version,
    submission.payload,
  );
  const expected = {
    ...distributionMetadata(submission, await query(version), metadata.signatureVerification),
    payloadVerification,
  };
  if (JSON.stringify(metadata) !== JSON.stringify(expected))
    throw new Error("Published metadata differs from verified AMO provenance");
  const names = [
    ...expected.artifacts.map((artifact) => artifact.name),
    "release-metadata.json",
    "SHA256SUMS.txt",
  ].sort();
  if (JSON.stringify(release.assets.map((asset) => asset.name).sort()) !== JSON.stringify(names))
    throw new Error("Unexpected public assets");
  for (const artifact of expected.artifacts) {
    download(tag, artifact.name);
    if (sha256(readFileSync(file(artifact.name))) !== artifact.sha256)
      throw new Error("Published artifact hash mismatch");
  }
  verifySignedPayload(readFileSync(file(expected.signedXpi.name)), version, submission.payload);
  download(tag, "SHA256SUMS.txt");
  const sums = formatChecksums([
    ...expected.artifacts,
    { name: "release-metadata.json", sha256: sha256(readFileSync(file("release-metadata.json"))) },
  ]);
  if (readFileSync(file("SHA256SUMS.txt"), "utf8") !== sums)
    throw new Error("Published checksum file mismatch");
  console.error("Existing signed release verified without changes");
}

async function main() {
  const mode = process.argv[2];
  if (mode === "select") {
    const requested = process.env.RELEASE_TAG;
    if (requested) releaseVersion(requested);
    const candidates = releases()
      .filter((release) => {
        try {
          releaseVersion(release.tag_name);
        } catch {
          return false;
        }
        return requested
          ? release.tag_name === requested
          : release.draft &&
              release.assets.some((asset) =>
                ["submission-state.json", "release-metadata.json"].includes(asset.name),
              );
      })
      .sort((a, b) => a.tag_name.localeCompare(b.tag_name, "en", { numeric: true }));
    if (requested && candidates.length !== 1)
      throw new Error("Requested release record does not exist");
    const taggedChannel = (candidate) => {
      const config = spawnSync("git", ["show", `${candidate.tag_name}:release-config.json`], {
        encoding: "utf8",
      });
      if (config.status !== 0 && candidate.tag_name !== "v1.1.0")
        throw new Error("Missing tagged channel configuration");
      return releaseChannel(config.status === 0 ? JSON.parse(config.stdout) : null);
    };
    const eligible = candidates.filter(
      (candidate) =>
        !process.env.SELECT_CHANNEL || taggedChannel(candidate) === process.env.SELECT_CHANNEL,
    );
    let tag = "";
    for (const candidate of eligible) {
      const commit = git("rev-parse", `${candidate.tag_name}^{commit}`);
      git("merge-base", "--is-ancestor", commit, "origin/main");
      verifyHistoricalTags();
      if (
        !requested &&
        !readPending(candidate.tag_name, commit, taggedChannel(candidate)).accepted
      ) {
        console.error(
          `Skipping ${candidate.tag_name}: submission is not recorded as accepted; phase 1 reconciliation required`,
        );
        continue;
      }
      tag = candidate.tag_name;
      output("commit", commit);
      break;
    }
    output("tag", tag);
    console.error(tag ? `Selected ${tag}` : "No pending release");
    return;
  }
  const tag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
  const { version, commit } = exactTag(tag);
  let existing = lookup(tag);

  if (mode === "submit") {
    if (existing && !existing.draft) {
      await verifyPublished(tag, version, commit, existing);
      return;
    }
    const stateBefore = await query(version);
    if (!existing && stateBefore.state !== "absent")
      throw new Error(
        "AMO version already exists without this pipeline's provenance record; refusing duplicate or takeover",
      );
    git("archive", "--format=zip", `--output=${file("net-identity-source.zip")}`, "HEAD");
    const packageBytes = readFileSync(`artifacts/net-identity-${version}.zip`);
    const fresh = parseSubmission({
      schemaVersion: 1,
      tag,
      version,
      commit,
      extensionId: EXTENSION_ID,
      channel,
      accepted: false,
      sourceSha256: sha256(readFileSync(file("net-identity-source.zip"))),
      payload: payloadHashes(packageBytes, version),
    });
    let submission = fresh;
    if (existing) {
      submission = readPending(tag, commit);
      if (!sameSubmission(submission, fresh))
        throw new Error("Rerun differs from original tested submission");
    } else {
      write("submission-state.json", submission);
      writeFileSync(
        file("pending.md"),
        "Awaiting AMO submission/review. This draft is not a signed Firefox release. No normal-user installer is published.\n",
      );
      gh(
        "release",
        "create",
        tag,
        "--verify-tag",
        "--draft",
        "--title",
        `Pending Mozilla approval: ${tag}`,
        "--notes-file",
        file("pending.md"),
        file("submission-state.json"),
        file("net-identity-source.zip"),
      );
    }
    const state = await ensureSubmission(
      () => query(version),
      async () => {
        const result = spawnSync(
          process.execPath,
          [
            "node_modules/web-ext/bin/web-ext.js",
            "sign",
            "--source-dir",
            "dist",
            "--artifacts-dir",
            "web-ext-artifacts",
            `--channel=${channel}`,
            "--amo-base-url",
            "https://addons.mozilla.org/api/v5/",
            "--amo-metadata",
            "amo-metadata.json",
            "--upload-source-code",
            file("net-identity-source.zip"),
            "--approval-timeout",
            channel === "unlisted" ? "120000" : "0",
            "--no-input",
          ],
          {
            encoding: "utf8",
            timeout: 600_000,
            maxBuffer: 4_000_000,
            env: {
              ...process.env,
              WEB_EXT_API_KEY: process.env.AMO_JWT_ISSUER,
              WEB_EXT_API_SECRET: process.env.AMO_JWT_SECRET,
            },
          },
        );
        // Never print raw web-ext output: error reports can contain request internals.
        // Query actual AMO state even if the client timed out after a successful POST.
        if (result.status !== 0) {
          const after = await query(version);
          if (after.state === "absent" || after.state === "rejected") {
            throw new Error(
              `AMO submission failed (web-ext exit ${result.status ?? "timeout"}; AMO ${after.state}). Historical versions were not modified. Inspect AMO review activity for details.`,
            );
          }
        }
      },
    );
    submission.accepted = true;
    write("submission-state.json", submission);
    upload(tag, ["submission-state.json", "net-identity-source.zip"]);
    console.error(
      `AMO accepted exact ${channel} ${version}; state=${state.state}. GitHub release remains draft.`,
    );
    return;
  }

  if (!existing) throw new Error("Missing release submission record");
  if (!existing.draft) {
    await verifyPublished(tag, version, commit, existing);
    return;
  }
  const submission = readPending(tag, commit);
  if (!submission.accepted)
    throw new Error("Submission is not recorded as accepted; rerun phase 1");
  const state = await query(version);
  if (state.state === "pending") {
    console.error(`Mozilla review pending (${state.status}); no publication`);
    return;
  }
  if (state.state !== "approved") throw new Error(`AMO ${state.state}; refusing publication`);
  const xpiName = `net-identity-${version}-firefox-signed.xpi`;
  if (mode === "prepare") {
    download(tag, "net-identity-source.zip");
    if (sha256(readFileSync(file("net-identity-source.zip"))) !== submission.sourceSha256)
      throw new Error("Source archive SHA-256 mismatch");
    const bytes = await downloadSigned(state.url, state.sha256, fetch, channel === "unlisted");
    // Keep only AMO-hash-verified bytes for diagnosis if the payload guard fails.
    // These are never release assets unless every subsequent check passes.
    writeFileSync(file("amo-download-diagnostic.xpi"), bytes);
    write("amo-download-diagnostic.json", {
      version,
      tag,
      commit,
      channel,
      amoSha256: state.sha256,
      expectedPayload: submission.payload,
      downloadedPayload: payloadHashes(bytes, version),
    });
    verifySignedPayload(bytes, version, submission.payload);
    writeFileSync(file(xpiName), bytes);
    output("approved", "true");
    output("version", version);
    output("xpi", file(xpiName));
    console.error(
      "Approved AMO bytes verified; Firefox signature verification required before publish",
    );
    return;
  }
  if (mode !== "publish") throw new Error("Unknown release operation");
  const bytes = readFileSync(file(xpiName));
  if (
    sha256(bytes) !== state.sha256 ||
    sha256(readFileSync(file("net-identity-source.zip"))) !== submission.sourceSha256
  )
    throw new Error("Artifact changed after verification");
  const payloadVerification = verifySignedPayload(bytes, version, submission.payload);
  const metadata = {
    ...distributionMetadata(submission, state, json("signature-proof.json")),
    payloadVerification,
  };
  write("release-metadata.json", metadata);
  writeFileSync(
    file("SHA256SUMS.txt"),
    formatChecksums([
      ...metadata.artifacts,
      {
        name: "release-metadata.json",
        sha256: sha256(readFileSync(file("release-metadata.json"))),
      },
    ]),
  );
  const pulls = JSON.parse(
    gh(
      "pr",
      "list",
      "--state",
      "merged",
      "--base",
      "main",
      "--limit",
      "200",
      "--json",
      "number,title,mergeCommit",
    ),
  );
  const titles = pulls.filter(
    (pull) =>
      pull.mergeCommit &&
      spawnSync("git", ["merge-base", "--is-ancestor", pull.mergeCommit.oid, commit]).status ===
        0 &&
      spawnSync("git", ["merge-base", "--is-ancestor", pull.mergeCommit.oid, HISTORICAL_COMMIT])
        .status !== 0,
  );
  writeFileSync(
    file("release.md"),
    formatGithubReleaseBody(titles, channel) +
      `\nAMO channel: ${channel}${state.listingUrl ? ` (${state.listingUrl})` : ""}\nTag: ${tag}\nCommit: ${commit}\n`,
  );
  upload(tag, [
    ...metadata.artifacts.map((artifact) => artifact.name),
    "release-metadata.json",
    "SHA256SUMS.txt",
  ]);
  // Remove only the draft's state record before publication; no public assets are deleted.
  existing = lookup(tag);
  if (!existing?.draft) throw new Error("Release changed concurrently");
  const allowed = new Set([
    ...metadata.artifacts.map((artifact) => artifact.name),
    "release-metadata.json",
    "SHA256SUMS.txt",
    "submission-state.json",
  ]);
  if (existing.assets.some((asset) => !allowed.has(asset.name)))
    throw new Error("Unexpected draft asset; refusing publication");
  for (const name of allowed) {
    if (name === "submission-state.json") continue;
    const asset = existing.assets.find((candidate) => candidate.name === name);
    if (asset?.digest !== `sha256:${sha256(readFileSync(file(name)))}`) {
      throw new Error("GitHub uploaded artifact digest mismatch; release remains draft");
    }
  }
  if (existing.assets.some((asset) => asset.name === "submission-state.json"))
    gh("release", "delete-asset", tag, "submission-state.json", "--yes");
  gh(
    "release",
    "edit",
    tag,
    "--draft=false",
    "--title",
    `net-identity ${tag}`,
    "--notes-file",
    file("release.md"),
    "--latest",
  );
  console.error(`Published verified Mozilla-signed ${tag}`);
}

try {
  await main();
} catch (error) {
  // All errors below are local validation messages, never API bodies or headers.
  console.error(error instanceof Error ? error.message : "Release operation failed");
  process.exitCode = 1;
}
