/** Main-only listing coordinator. Never signs, submits versions, deletes media or creates credentials. */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { amoGet, record } from "../src/release/amo-api.ts";
import { mozillaUrl } from "../src/release/amo-policy.ts";
import { EXTENSION_ID, parseSemver } from "../src/release/version.ts";
import {
  SCREENSHOTS,
  parseListingCopy,
  withEnglish,
  assertPublishable,
  assertFinalizedRelease,
  parseReceipt,
  previewsFrom,
  checkPreviewOwnership,
  samePreviewImage,
  environmentListingClient,
  assertNoPending,
  assertFreshRunAttempt,
  assertFirstInitialization,
  assertSameApproval,
  assertUnchangedLocales,
  recordedMutation,
} from "../src/release/amo-listing.ts";

const out = "artifacts/listing";
mkdirSync(out, { recursive: true });
const read = (name, max = 2000000) => {
  const bytes = readFileSync(name);
  if (bytes.length > max) throw new Error("Listing input exceeds size limit");
  return bytes;
};
const json = (name) => JSON.parse(read(name).toString("utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (name, value) => {
  writeFileSync(`${out}/${name}.tmp`, JSON.stringify(value, null, 2) + "\n");
  renameSync(`${out}/${name}.tmp`, `${out}/${name}`);
};
const command = (name, args) => {
  const r = spawnSync(name, args, { encoding: "utf8", timeout: 60000, maxBuffer: 2000000 });
  if (r.status !== 0) throw new Error(`${name} listing preflight failed`);
  return r.stdout.trim();
};
const gh = (...args) => command("gh", args);
const repo = "jacek4yang/net-identity";
const iconPath = "public/icons/icon-128.png";
function png(name, width, height) {
  const bytes = read(name, 5000000);
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(16) !== width ||
    bytes.readUInt32BE(20) !== height
  )
    throw new Error("Invalid listing PNG dimensions");
  return bytes;
}
function receiptFromPreviousRun() {
  const runId = process.env.RECEIPT_RUN_ID || "";
  const currentNumber = Number(process.env.GITHUB_RUN_NUMBER);
  if (!Number.isSafeInteger(currentNumber) || currentNumber < 1)
    throw new Error("Invalid current run number");
  // Read all history within a hard bound. Never treat a truncated history as first publication.
  const history = JSON.parse(
    gh(
      "api",
      `repos/${repo}/actions/workflows/amo-listing.yml/runs?branch=main&event=workflow_dispatch&per_page=100`,
    ),
  );
  if (
    !Number.isSafeInteger(history.total_count) ||
    history.total_count > 100 ||
    !Array.isArray(history.workflow_runs) ||
    history.workflow_runs.length !== history.total_count
  )
    throw new Error("Listing run history exceeds safe bound; operator reconciliation required");
  if (
    history.workflow_runs.some(
      (r) =>
        !Number.isSafeInteger(r.run_number) ||
        r.run_number < 1 ||
        !Number.isSafeInteger(r.id) ||
        r.id < 1,
    )
  )
    throw new Error("Malformed listing history; operator reconciliation required");
  const prior = history.workflow_runs
    .filter((r) => Number.isSafeInteger(r.run_number) && r.run_number < currentNumber)
    .sort((a, b) => b.run_number - a.run_number)[0];
  assertFirstInitialization(currentNumber, Boolean(prior));
  if (!prior) {
    if (runId) throw new Error("Unexpected receipt for first listing run");
    return null;
  }
  if (!runId || String(prior.id) !== runId)
    throw new Error(`Latest prior listing run receipt required: ${prior.id}`);
  if (!/^[1-9]\d{0,19}$/.test(runId)) throw new Error("Invalid receipt run ID");
  const run = JSON.parse(gh("api", `repos/${repo}/actions/runs/${runId}`));
  if (
    run.status !== "completed" ||
    run.run_number >= currentNumber ||
    run.id !== prior.id ||
    run.head_branch !== "main" ||
    run.event !== "workflow_dispatch" ||
    run.path !== ".github/workflows/amo-listing.yml" ||
    run.repository?.full_name !== repo ||
    typeof run.head_sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(run.head_sha)
  )
    throw new Error("Receipt must come from the trusted main-only listing workflow");
  command("git", ["merge-base", "--is-ancestor", run.head_sha, "origin/main"]);
  const dir = `${out}/previous`;
  mkdirSync(dir, { recursive: true });
  gh("run", "download", runId, "--repo", repo, "--name", "amo-listing-receipt", "--dir", dir);
  return json(`${dir}/receipt.json`);
}
async function main() {
  assertFreshRunAttempt(process.env.GITHUB_RUN_ATTEMPT);
  if (
    process.env.GITHUB_REPOSITORY !== repo ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
  )
    throw new Error("Listing workflow is main-only");
  const dry = process.env.DRY_RUN !== "false";
  const pkg = json("package.json");
  const manifest = json("public/manifest.json");
  const version = pkg.version;
  if (
    !parseSemver(version) ||
    version !== manifest.version ||
    manifest.browser_specific_settings?.gecko?.id !== EXTENSION_ID
  )
    throw new Error("Listing package/manifest mismatch");
  const copy = parseListingCopy(json("store-assets/listing-en-US.json"));
  const channel = json("release-config.json").channel;
  const capture = json("store-assets/screenshots/metadata.json");
  if (
    capture.extensionVersion !== version ||
    !Array.isArray(capture.images) ||
    capture.images.length !== 4
  )
    throw new Error("Screenshot provenance version mismatch");
  const icon = png(iconPath, 128, 128);
  const images = SCREENSHOTS.map((name) => {
    const bytes = png(`store-assets/screenshots/${name}`, 1280, 800);
    if (capture.images.find((i) => i.file === name)?.sha256 !== hash(bytes))
      throw new Error("Screenshot hash mismatch");
    return { name, bytes, sha256: hash(bytes) };
  });
  const planSha256 = hash(
    JSON.stringify({ version, copy, icon: hash(icon), images: images.map((i) => i.sha256) }),
  );
  const rawReceipt = receiptFromPreviousRun();
  // Only a proven no-write receipt can be discarded when version/copy/assets change.
  const reusable =
    rawReceipt === null
      ? null
      : parseReceipt(rawReceipt, rawReceipt.version, rawReceipt.planSha256);
  if (reusable) {
    save("receipt.json", reusable);
    assertNoPending(reusable);
  }
  const freshPlan =
    reusable === null ||
    (!reusable.attemptedWrites &&
      reusable.previews.length === 0 &&
      !reusable.icon &&
      !reusable.copyAccepted &&
      !reusable.privacyAccepted);
  const receipt = freshPlan
    ? {
        schemaVersion: 1,
        dryRun: dry,
        attemptedWrites: false,
        extensionId: EXTENSION_ID,
        version,
        planSha256,
        previews: [],
        status: "in-progress",
      }
    : parseReceipt(reusable, version, planSha256);
  receipt.dryRun = dry;
  const persist = () => save("receipt.json", receipt);
  persist();
  const api = environmentListingClient();
  const addon = record(await amoGet(""));
  const detail = await amoGet(`versions/v${version}/`);
  let approved;
  try {
    approved = assertPublishable(addon, detail, version, channel);
  } catch {
    if (!dry) throw new Error("Publish blocked: exact current listed version must be public");
    save("plan.json", {
      version,
      planSha256,
      dryRun: true,
      ready: false,
      reason: "Exact current listed version not public",
      previews: images.map((i) => ({ name: i.name, sha256: i.sha256 })),
    });
    console.error("Dry run: no writes; listed/current/public version gate is not ready");
    return;
  }
  const tag = `v${version}`;
  const release = JSON.parse(gh("api", `repos/${repo}/releases/tags/${tag}`));
  if (release.draft !== false || release.prerelease !== false || release.tag_name !== tag)
    throw new Error("Finalized public GitHub release required");
  gh(
    "release",
    "download",
    tag,
    "--repo",
    repo,
    "--pattern",
    "release-metadata.json",
    "--dir",
    out,
    "--clobber",
  );
  const proof = json(`${out}/release-metadata.json`);
  const commit = command("git", ["rev-parse", `${tag}^{commit}`]);
  command("git", ["merge-base", "--is-ancestor", commit, "origin/main"]);
  assertFinalizedRelease(proof, version, commit, approved.sha256);
  const sourceHashes = record(capture.sourceHashes);
  const requiredSources = [
    "popup/popup.html",
    "popup/popup.css",
    "popup/popup.js",
    "options/options.html",
    "options/options.css",
    "options/options.js",
  ];
  if (
    Object.keys(sourceHashes).length !== requiredSources.length ||
    requiredSources.some((name) => sourceHashes[name] !== proof.submission.payload[name])
  )
    throw new Error("Screenshots do not match finalized release UI payload");
  if (proof.submission.payload["icons/icon-128.png"] !== hash(icon))
    throw new Error("Icon differs from finalized release payload");
  let remote = previewsFrom(addon);
  checkPreviewOwnership(remote, receipt);
  if (receipt.previews.some((p) => !images.some((i) => i.sha256 === p.sha256)))
    throw new Error("Unknown preview receipt hash");
  if (receipt.icon && receipt.icon.sha256 !== hash(icon))
    throw new Error("Icon receipt mismatch; operator reconciliation required");
  const privacy = record(await api("privacy-read"));
  const fields = {
    summary: withEnglish(addon.summary, copy.summary["en-US"]),
    description: withEnglish(addon.description, copy.description["en-US"]),
  };
  const policy = {
    privacy_policy: withEnglish(privacy.privacy_policy, copy.privacy_policy["en-US"]),
  };
  save("plan.json", {
    version,
    planSha256,
    dryRun: dry,
    ready: true,
    copyChanges: Object.keys(fields).filter(
      (k) => JSON.stringify(fields[k]) !== JSON.stringify(addon[k]),
    ),
    privacyChange: JSON.stringify(policy.privacy_policy) !== JSON.stringify(privacy.privacy_policy),
    iconUpload: !receipt.icon,
    newPreviews: images
      .filter((i) => !receipt.previews.some((p) => p.sha256 === i.sha256))
      .map((i) => i.name),
  });
  if (dry) {
    console.error("Dry run ready; no AMO changes made");
    return;
  }
  // Serialize with release workflows and bind every write to the exact finalized AMO file.
  const mutate = async (operation, body, id, pending, accept) => {
    const currentAddon = record(await amoGet(""));
    const currentApproval = assertPublishable(
      currentAddon,
      await amoGet(`versions/v${version}/`),
      version,
      channel,
    );
    assertSameApproval(approved, currentApproval);
    if (operation === "copy") {
      assertUnchangedLocales(addon.summary, currentAddon.summary);
      assertUnchangedLocales(addon.description, currentAddon.description);
    }
    if (operation === "privacy") {
      const currentPolicy = record(await api("privacy-read"));
      assertUnchangedLocales(privacy.privacy_policy, currentPolicy.privacy_policy);
    }
    await recordedMutation(
      receipt,
      { operation, ...pending },
      persist,
      () => api(operation, body, id),
      accept,
    );
  };
  if (!receipt.copyAccepted) {
    if (Object.keys(fields).some((k) => JSON.stringify(fields[k]) !== JSON.stringify(addon[k])))
      await mutate("copy", fields, undefined, {}, () => {
        receipt.copyAccepted = true;
      });
    else {
      receipt.copyAccepted = true;
      persist();
    }
  }
  if (!receipt.privacyAccepted) {
    if (JSON.stringify(policy.privacy_policy) !== JSON.stringify(privacy.privacy_policy))
      await mutate("privacy", policy, undefined, {}, () => {
        receipt.privacyAccepted = true;
      });
    else {
      receipt.privacyAccepted = true;
      persist();
    }
  }
  if (!receipt.icon) {
    const form = new FormData();
    form.set("icon", new Blob([icon], { type: "image/png" }), "icon-128.png");
    await mutate("icon", form, undefined, {}, (result) => {
      // This URL is only an observation: asynchronous resizing can replace a default URL.
      receipt.icon = { sha256: hash(icon), url: mozillaUrl(record(result).icon_url) };
    });
  }
  for (let index = 0; index < images.length; index++) {
    const image = images[index];
    let entry = receipt.previews.find((p) => p.sha256 === image.sha256);
    if (!entry) {
      remote = previewsFrom(await api("read"));
      checkPreviewOwnership(remote, receipt);
      const form = new FormData();
      form.set("image", new Blob([image.bytes], { type: "image/png" }), image.name);
      form.set("position", String(index));
      await mutate(
        "preview-create",
        form,
        undefined,
        { sourceSha256: image.sha256, position: index, beforeIds: remote.map((p) => p.id) },
        (created) => {
          const preview = previewsFrom({ previews: [created] })[0];
          if (!preview || remote.some((p) => p.id === preview.id))
            throw new Error("Unexpected created preview identity");
          entry = { sha256: image.sha256, id: preview.id, url: preview.url };
          receipt.previews.push(entry);
        },
      ); // Confirmed ID and cleared intent are persisted together, before caption PATCH.
    }
    const current = previewsFrom(await api("read")).find((p) => p.id === entry.id);
    if (!current || !samePreviewImage(current.url, entry.url))
      throw new Error("Preview changed; operator reconciliation required");
    const caption = withEnglish(current.caption, copy.captions[index]);
    if (current.caption["en-US"] !== copy.captions[index] || current.position !== index) {
      const fresh = previewsFrom(await api("read")).find((p) => p.id === entry.id);
      if (!fresh || !samePreviewImage(fresh.url, entry.url) || fresh.position !== current.position)
        throw new Error("Preview changed concurrently");
      assertUnchangedLocales(current.caption, fresh.caption);
      await mutate("preview-caption", { caption, position: index }, entry.id, {}, (result) => {
        const updated = previewsFrom({ previews: [result] })[0];
        if (!updated || updated.id !== entry.id || !samePreviewImage(updated.url, entry.url))
          throw new Error("Unexpected updated preview identity");
        entry.url = updated.url;
      });
    }
  }
  receipt.status = "accepted-public-readback-pending";
  persist();
  const publicAddon = record(await api("read", undefined, undefined, true));
  const publicPolicy = record(await api("privacy-read", undefined, undefined, true));
  const publicPreviews = previewsFrom(publicAddon);
  const visible =
    record(publicAddon.summary)["en-US"] === copy.summary["en-US"] &&
    record(publicAddon.description)["en-US"] === copy.description["en-US"] &&
    record(publicPolicy.privacy_policy)["en-US"] === copy.privacy_policy["en-US"] &&
    images.every((image, i) =>
      publicPreviews.some(
        (p) =>
          p.id === receipt.previews.find((r) => r.sha256 === image.sha256)?.id &&
          p.caption["en-US"] === copy.captions[i],
      ),
    );
  if (visible) receipt.status = "public-text-and-preview-metadata-verified";
  persist();
  console.error(
    visible
      ? "Public text and preview metadata verified; rendered media/async icon still require visual verification"
      : "AMO accepted listing changes; public readback pending moderation/cache. No publication claim.",
  );
}
try {
  await main();
} catch (error) {
  // Our own validation messages only; never dump API bodies or child-process output.
  console.error(error instanceof Error ? error.message : "Listing operation failed");
  process.exitCode = 1;
}
