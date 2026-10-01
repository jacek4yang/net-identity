import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AMO_BASE } from "../src/release/amo-api";
import { EXTENSION_ID } from "../src/release/version";
import {
  assertFinalizedRelease,
  assertNoPending,
  assertFreshRunAttempt,
  assertFirstInitialization,
  assertSameApproval,
  assertUnchangedLocales,
  recordedMutation,
  assertPublishable,
  checkPreviewOwnership,
  samePreviewImage,
  listingClient,
  parseListingCopy,
  parseReceipt,
  previewsFrom,
  withEnglish,
  type ListingOperation,
  type ListingReceipt,
} from "../src/release/amo-listing";

const sha = "a".repeat(64);
const version = "1.1.3";
const commit = "b".repeat(40);
const imageUrl = "https://addons.mozilla.org/user-media/previews/full/123.png";
const addon = {
  guid: EXTENSION_ID,
  status: "public",
  is_disabled: false,
  url: "https://addons.mozilla.org/en-US/firefox/addon/net-identity/",
  current_version: { version },
  previews: [],
  icon_url: imageUrl,
};
const detail = {
  version,
  channel: "listed",
  id: 100,
  is_disabled: false,
  file: {
    id: 200,
    status: "public",
    is_mozilla_signed_extension: false,
    hash: `sha256:${sha}`,
    url: "https://addons.mozilla.org/firefox/downloads/file/200/file.xpi",
  },
};
const baseReceipt: ListingReceipt = {
  schemaVersion: 1,
  dryRun: true,
  attemptedWrites: false,
  extensionId: EXTENSION_ID,
  version,
  planSha256: sha,
  previews: [],
  status: "in-progress",
};
const copy = {
  summary: { "en-US": "Clear summary" },
  description: { "en-US": "Description" },
  privacy_policy: { "en-US": "Privacy" },
  captions: ["One", "Two", "Three", "Four"],
};
const proof = {
  mozillaSigned: true,
  submission: {
    schemaVersion: 1,
    extensionId: EXTENSION_ID,
    version,
    tag: `v${version}`,
    commit,
    channel: "listed",
    accepted: true,
    sourceSha256: sha,
    payload: { "manifest.json": sha },
  },
  signatureVerification: {
    signed: true,
    extensionId: EXTENSION_ID,
    version,
    sha256: sha,
    firefoxVersion: "158.0",
    signedState: 2,
    signatureRequired: true,
    temporarilyInstalled: false,
    updateUrl: null,
  },
};

describe("listing policy", () => {
  it("accepts only the exact current public listed version", () => {
    expect(assertPublishable(addon, detail, version, "listed").state).toBe("approved");
    for (const bad of [
      { ...addon, guid: "another" },
      { ...addon, status: "nominated" },
      { ...addon, is_disabled: true },
      { ...addon, current_version: { version: "1.1.4" } },
    ])
      expect(() => assertPublishable(bad, detail, version, "listed")).toThrow();
    for (const bad of [
      { ...detail, channel: "unlisted" },
      { ...detail, is_disabled: true },
      { ...detail, file: { ...detail.file, status: "unreviewed" } },
    ])
      expect(() => assertPublishable(addon, bad, version, "listed")).toThrow();
    expect(() => assertPublishable(addon, detail, version, "unlisted")).toThrow();
  });
  it("requires matching permanent signature proof from finalized release", () => {
    expect(() => assertFinalizedRelease(proof, version, commit, sha)).not.toThrow();
    expect(() => assertFinalizedRelease(proof, version, "c".repeat(40), sha)).toThrow();
    expect(() =>
      assertFinalizedRelease({ ...proof, mozillaSigned: false }, version, commit, sha),
    ).toThrow();
    expect(() =>
      assertFinalizedRelease(
        {
          ...proof,
          signatureVerification: {
            ...proof.signatureVerification,
            temporarilyInstalled: true,
          },
        },
        version,
        commit,
        sha,
      ),
    ).toThrow();
  });
  it("bounds the actual reviewed en-US copy and preserves every other locale", () => {
    const actual = parseListingCopy(
      JSON.parse(readFileSync("store-assets/listing-en-US.json", "utf8")),
    );
    expect(actual.summary["en-US"].length).toBeLessThanOrEqual(250);
    expect(actual.description["en-US"]).toContain("not a browser-wide");
    expect(actual.privacy_policy["en-US"]).toContain("Protected Firefox requests");
    expect(withEnglish({ "en-US": "old", "zh-CN": "保留" }, "new")).toEqual({
      "en-US": "new",
      "zh-CN": "保留",
    });
    expect(() => withEnglish({ fr: 42 }, "new")).toThrow();
    expect(() => parseListingCopy({ ...copy, summary: { "en-US": "x".repeat(251) } })).toThrow();
    expect(() => parseListingCopy({ ...copy, description: { "en-US": "a", fr: "b" } })).toThrow();
    expect(() => parseListingCopy({ ...copy, captions: ["one"] })).toThrow();
  });
  it("allows empty first publication but refuses every unproven existing image", () => {
    expect(() => checkPreviewOwnership([], baseReceipt)).not.toThrow();
    const previews = previewsFrom({
      previews: [{ id: 7, image_url: imageUrl, caption: { "en-US": "One" }, position: 0 }],
    });
    expect(() => checkPreviewOwnership(previews, baseReceipt)).toThrow(/IDs: 7/);
    const receipt = parseReceipt(
      { ...baseReceipt, previews: [{ sha256: sha, id: 7, url: imageUrl }] },
      version,
      sha,
    );
    expect(() => checkPreviewOwnership(previews, receipt)).not.toThrow();
    expect(() => checkPreviewOwnership([], receipt)).toThrow();
    expect(() =>
      checkPreviewOwnership(
        previews.map((p) => ({ ...p, url: imageUrl + "?changed=1" })),
        receipt,
      ),
    ).toThrow();
  });
  it("rejects foreign, duplicate, stale and malformed receipt identities", () => {
    expect(
      parseReceipt({ ...baseReceipt, copyAccepted: true, privacyAccepted: true }, version, sha),
    ).toMatchObject({ copyAccepted: true });
    for (const bad of [
      { ...baseReceipt, version: "1.0.0" },
      { ...baseReceipt, planSha256: "c".repeat(64) },
      { ...baseReceipt, extensionId: "other" },
      { ...baseReceipt, copyAccepted: false },
      { ...baseReceipt, previews: [{ sha256: sha, id: 0, url: imageUrl }] },
      { ...baseReceipt, icon: { sha256: sha, url: "https://evil.invalid/icon.png" } },
      {
        ...baseReceipt,
        previews: [
          { sha256: sha, id: 1, url: imageUrl },
          { sha256: sha, id: 1, url: imageUrl },
        ],
      },
    ])
      expect(() => parseReceipt(bad, version, sha)).toThrow();
    expect(() =>
      previewsFrom({ previews: [{ id: 1, image_url: "http://addons.mozilla.org/a" }] }),
    ).toThrow();
  });
});

describe("fixed-origin listing transport", () => {
  function setup(status = 200, response = "{}") {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(response, { status }));
    return { request, api: listingClient(() => "fixture-token", request) };
  }
  it("sends description and privacy through separate allowlisted PATCH endpoints", async () => {
    const { request, api } = setup();
    await api("copy", { summary: copy.summary, description: copy.description });
    expect(request).toHaveBeenLastCalledWith(
      AMO_BASE,
      expect.objectContaining({ method: "PATCH", redirect: "error" }),
    );
    await api("privacy", { privacy_policy: copy.privacy_policy });
    expect(request).toHaveBeenLastCalledWith(
      AMO_BASE + "eula_policy/",
      expect.objectContaining({ method: "PATCH" }),
    );
    await expect(api("privacy", { eula: { "en-US": "forbidden" } })).rejects.toThrow(/field/);
    await expect(api("copy", { is_disabled: true })).rejects.toThrow(/field/);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("uses multipart uploads and validated numeric caption targets only", async () => {
    const { request, api } = setup();
    const form = new FormData();
    form.set("image", new Blob(["fixture"]), "fixture.png");
    form.set("position", "0");
    await api("preview-create", form);
    expect(request).toHaveBeenLastCalledWith(
      AMO_BASE + "previews/",
      expect.objectContaining({ method: "POST", body: form }),
    );
    const headers = request.mock.calls[0]?.[1]?.headers;
    expect(headers).not.toHaveProperty("Content-Type");
    await api("preview-caption", { caption: { "en-US": "One" }, position: 0 }, 123);
    expect(request).toHaveBeenLastCalledWith(
      AMO_BASE + "previews/123/",
      expect.objectContaining({ method: "PATCH" }),
    );
    await expect(api("preview-caption", { caption: {} }, -1)).rejects.toThrow(/target/);
    await expect(api("icon", { icon: "not multipart" })).rejects.toThrow(/format/);
    await expect(api("delete" as ListingOperation, {})).rejects.toThrow(/operation/);
  });
  it("never sends JWT for public readback or permits unauthenticated writes", async () => {
    const { request, api } = setup();
    await api("read", undefined, undefined, true);
    expect(request.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
    await expect(api("copy", { summary: copy.summary }, undefined, true)).rejects.toThrow(
      /Unauthenticated/,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("stops on 403 without exposing response bodies or retrying", async () => {
    const { request, api } = setup(403, "private response fixture-token");
    await expect(api("privacy", { privacy_policy: copy.privacy_policy })).rejects.toThrow(
      "HTTP 403; stop without credential changes",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not retry an ambiguous POST and redacts transport error content", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("Authorization fixture-secret"));
    const api = listingClient(() => "fixture-token", request);
    const form = new FormData();
    form.set("image", new Blob(["fixture"]));
    await expect(api("preview-create", form)).rejects.toThrow(
      "outcome uncertain; no automatic write retry",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("bounds and sanitizes response parsing", async () => {
    await expect(setup(200, "x".repeat(2000001)).api("read")).rejects.toThrow(/exceeds limit/);
    await expect(setup(200, "not JSON fixture-token").api("read")).rejects.toThrow(
      /Invalid listing response/,
    );
  });
});

describe("isolated workflow and orchestration guards", () => {
  const workflow = readFileSync(".github/workflows/amo-listing.yml", "utf8");
  const script = readFileSync("scripts/amo-listing.mjs", "utf8");
  it("defaults to dry-run, main-only, existing secrets and read-only GitHub permissions", () => {
    expect(workflow).toContain("default: true");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("AMO_JWT_ISSUER");
    expect(workflow).toContain("AMO_JWT_SECRET");
    expect(workflow).not.toMatch(/contents: write|pull_request:|schedule:|npm ci/);
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("persist-credentials: false");
  });
  it("ties media to finalized payload and persists receipts before caption edits", () => {
    expect(script).toContain("assertFinalizedRelease");
    expect(script).toContain("proof.submission.payload[name]");
    expect(script).toContain('proof.submission.payload["icons/icon-128.png"]');
    expect(script.indexOf("checkPreviewOwnership(remote, receipt)")).toBeLessThan(
      script.indexOf('mutate("copy"'),
    );
    expect(script.indexOf("receipt.previews.push(entry)")).toBeLessThan(
      script.indexOf('mutate("preview-caption"'),
    );
    expect(script).not.toMatch(/delete-asset|DELETE|web-ext.*sign/);
    expect(script).toContain("rendered media/async icon still require visual verification");
  });
});

describe("listing recovery and rendering regressions", () => {
  it("uses only AMO-supported HTML, balanced lists and no raw Markdown in the actual copy", () => {
    const actual = parseListingCopy(
      JSON.parse(readFileSync("store-assets/listing-en-US.json", "utf8")),
    );
    for (const text of [actual.description["en-US"], actual.privacy_policy["en-US"]]) {
      expect(text).toContain("<strong>");
      expect(text).toContain("<ul><li>");
      expect(text).not.toMatch(/\*\*|`|^#+\s|^\s*[-|]\s|\]\(https?:/m);
      const stack: string[] = [];
      for (const match of text.matchAll(/<(\/?)([a-z]+)([^>]*)>/g)) {
        const [, closing, tag, attrs] = match;
        expect(["strong", "br", "ul", "ol", "li", "a", "code"]).toContain(tag);
        expect(
          attrs === "" || (tag === "a" && /^ href="https:\/\/[^"<>]+"$/.test(attrs ?? "")),
        ).toBe(true);
        if (tag === "br") continue;
        if (closing) expect(stack.pop()).toBe(tag);
        else stack.push(String(tag));
      }
      expect(stack).toEqual([]);
    }
    expect(actual.description["en-US"]).toContain("<ol><li>");
    expect(actual.privacy_policy["en-US"]).toContain("Profiles and non-secret applied route:");
  });
  it("binds every mutation to the exact finalized version ID, file ID and hash", () => {
    const initial = assertPublishable(addon, detail, version, "listed");
    expect(() => assertSameApproval(initial, { ...initial })).not.toThrow();
    for (const changed of [
      { ...initial, versionId: 101 },
      { ...initial, fileId: 201 },
      { ...initial, sha256: "c".repeat(64) },
    ])
      expect(() => assertSameApproval(initial, changed)).toThrow(/Approved file changed/);
  });
  it("stops changed locales while ignoring harmless object ordering", () => {
    expect(() =>
      assertUnchangedLocales({ fr: "Oui", "en-US": "Old" }, { "en-US": "Old", fr: "Oui" }),
    ).not.toThrow();
    for (const changed of [
      { fr: "New", "en-US": "Old" },
      { fr: "Oui", "en-US": "Updated" },
      { fr: "Oui", "en-US": "Old", de: "Neu" },
    ])
      expect(() => assertUnchangedLocales({ fr: "Oui", "en-US": "Old" }, changed)).toThrow(
        /concurrently/,
      );
  });
  it("retains pending create after accepted-but-uncertain response, even with empty remote read", async () => {
    const receipt: ListingReceipt = structuredClone(baseReceipt);
    let saved = "";
    const persist = () => {
      saved = JSON.stringify(receipt);
    };
    const request = vi.fn(async () => {
      throw new Error("response lost after server accepted");
    });
    await expect(
      recordedMutation(
        receipt,
        { operation: "preview-create", sourceSha256: sha, position: 0, beforeIds: [] },
        persist,
        request,
        () => {},
      ),
    ).rejects.toThrow();
    const resumed = parseReceipt(JSON.parse(saved), version, sha);
    expect(resumed.attemptedWrites).toBe(true);
    expect(() => checkPreviewOwnership([], resumed)).not.toThrow();
    expect(() => assertNoPending(resumed)).toThrow(/reconciliation/);
    await expect(
      recordedMutation(
        resumed,
        { operation: "preview-create", sourceSha256: sha, position: 0, beforeIds: [] },
        persist,
        request,
        () => {},
      ),
    ).rejects.toThrow(/reconciliation/);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("persists intent before process interruption and atomically records confirmed results", async () => {
    const receipt: ListingReceipt = structuredClone(baseReceipt);
    const checkpoints: string[] = [];
    const persist = () => {
      checkpoints.push(JSON.stringify(receipt));
    };
    await recordedMutation(
      receipt,
      { operation: "icon" },
      persist,
      async () => {
        const interrupted = parseReceipt(JSON.parse(checkpoints[0] ?? "null"), version, sha);
        expect(() => assertNoPending(interrupted)).toThrow();
        return { icon_url: "https://addons.mozilla.org/static/img/addon-icons/default-64.png" };
      },
      (result) => {
        receipt.icon = { sha256: sha, url: result.icon_url };
      },
    );
    expect(checkpoints).toHaveLength(2);
    const confirmed = parseReceipt(JSON.parse(checkpoints[1] ?? "null"), version, sha);
    expect(confirmed.pending).toBeUndefined();
    expect(confirmed.icon?.sha256).toBe(sha);
    // Completion can change icon_url later; uploaded source hash is the resume identity.
    const script = readFileSync("scripts/amo-listing.mjs", "utf8");
    expect(script).not.toContain("receipt.icon.url !== addon.icon_url");
    expect(script).toContain("receipt.icon.sha256 !== hash(icon)");
  });
  it("retains durable pending intent if the process stops before confirmed-result persistence", async () => {
    const receipt: ListingReceipt = structuredClone(baseReceipt);
    let durable = "";
    let writes = 0;
    const request = vi.fn(async () => ({ id: 7, url: imageUrl }));
    await expect(
      recordedMutation(
        receipt,
        { operation: "preview-create", sourceSha256: sha, position: 0, beforeIds: [] },
        () => {
          if (++writes === 2) throw new Error("process stopped before atomic rename");
          durable = JSON.stringify(receipt);
        },
        request,
        (created) => {
          receipt.previews.push({ sha256: sha, ...created });
        },
      ),
    ).rejects.toThrow(/process stopped/);
    const resumed = parseReceipt(JSON.parse(durable), version, sha);
    expect(resumed.previews).toEqual([]);
    expect(() => assertNoPending(resumed)).toThrow(/reconciliation/);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("marks uncertain copy, privacy and caption PATCHes pending as well", async () => {
    for (const operation of ["copy", "privacy", "preview-caption"] as const) {
      const receipt: ListingReceipt = structuredClone(baseReceipt);
      let saved = "";
      await expect(
        recordedMutation(
          receipt,
          { operation },
          () => {
            saved = JSON.stringify(receipt);
          },
          async () => {
            throw new Error("uncertain");
          },
          () => {},
        ),
      ).rejects.toThrow();
      expect(() => assertNoPending(parseReceipt(JSON.parse(saved), version, sha))).toThrow();
    }
  });
  it("requires latest completed prior run, bounded complete history, and atomic receipt writes", () => {
    const script = readFileSync("scripts/amo-listing.mjs", "utf8");
    expect(script).toContain("history.total_count > 100");
    expect(script).toContain("r.run_number < currentNumber");
    expect(script).toContain("String(prior.id) !== runId");
    expect(script).toContain('run.status !== "completed"');
    expect(script).toContain("renameSync");
    expect(script).toContain("!reusable.attemptedWrites");
    expect(script).toContain("assertSameApproval(approved, currentApproval)");
    expect(script).toContain("assertUnchangedLocales(addon.description, currentAddon.description)");
  });
});

describe("GitHub listing run identity", () => {
  it("rejects job reruns sharing a run ID and number", () => {
    expect(() => assertFreshRunAttempt("1")).not.toThrow();
    for (const attempt of ["2", "3", "0", "", undefined, 1])
      expect(() => assertFreshRunAttempt(attempt)).toThrow(/fresh workflow_dispatch/);
    const script = readFileSync("scripts/amo-listing.mjs", "utf8");
    expect(script.indexOf("assertFreshRunAttempt(process.env.GITHUB_RUN_ATTEMPT)")).toBeLessThan(
      script.indexOf("const dry ="),
    );
  });
  it("allows empty initialization only for run number one, never missing/deleted history", () => {
    expect(() => assertFirstInitialization(1, false)).not.toThrow();
    expect(() => assertFirstInitialization(2, true)).not.toThrow();
    for (const number of [2, 3, 100])
      expect(() => assertFirstInitialization(number, false)).toThrow(/history is missing/);
    const script = readFileSync("scripts/amo-listing.mjs", "utf8");
    expect(script).toContain("assertFirstInitialization(currentNumber, Boolean(prior))");
  });
});

describe("AMO preview cache-buster", () => {
  it("allows only numeric modified timestamp changes while preserving image ownership", () => {
    const before = imageUrl + "?modified=100";
    const after = imageUrl + "?modified=200";
    expect(samePreviewImage(before, after)).toBe(true);
    expect(samePreviewImage(imageUrl, after)).toBe(true);
    expect(samePreviewImage(before, after + "&changed=1")).toBe(false);
    expect(samePreviewImage(before, before.replace("123.png", "124.png"))).toBe(false);
    expect(
      samePreviewImage(before, before.replace("addons.mozilla.org", "addons.cdn.mozilla.net")),
    ).toBe(false);
    expect(() => samePreviewImage(before, imageUrl + "?modified=bad")).toThrow();
    expect(() => samePreviewImage(before, imageUrl + "?modified=1&modified=2")).toThrow();
    const receipt = { ...baseReceipt, previews: [{ sha256: sha, id: 7, url: before }] };
    expect(() =>
      checkPreviewOwnership([{ id: 7, url: after, caption: {}, position: 0 }], receipt),
    ).not.toThrow();
    expect(() =>
      checkPreviewOwnership([{ id: 8, url: after, caption: {}, position: 0 }], receipt),
    ).toThrow();
  });
  it("validates caption response identity and records its new observed URL", () => {
    const script = readFileSync("scripts/amo-listing.mjs", "utf8");
    expect(script).toContain("updated.id !== entry.id");
    expect(script).toContain("!samePreviewImage(updated.url, entry.url)");
    expect(script).toContain("entry.url = updated.url");
  });
});
