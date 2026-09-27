import { describe, expect, it, vi } from "vitest";
import {
  amoState,
  ensureSubmission,
  mozillaUrl,
  releaseVersion,
  HISTORICAL_COMMIT,
  LISTED_110_COMMIT,
  releaseChannel,
} from "../src/release/amo-policy";
import { distributionMetadata, parseSubmission, sameSubmission } from "../src/release/distribution";
import { downloadSigned, sha256 } from "../src/release/download";
import { EXTENSION_ID, formatGithubReleaseBody } from "../src/release/version";

const hash = "a".repeat(64);
const addon = {
  guid: EXTENSION_ID,
  status: "public",
  is_disabled: false,
  url: "https://addons.mozilla.org/firefox/addon/net-identity/",
};
const detail = {
  id: 123,
  version: "1.1.0",
  channel: "listed",
  is_disabled: false,
  file: {
    id: 456,
    status: "public",
    is_mozilla_signed_extension: false,
    hash: `sha256:${hash}`,
    url: "https://addons.mozilla.org/firefox/downloads/file/456/addon.xpi",
  },
};
const submission = parseSubmission({
  schemaVersion: 1,
  tag: "v1.1.0",
  version: "1.1.0",
  commit: "b".repeat(40),
  extensionId: EXTENSION_ID,
  channel: "listed",
  accepted: true,
  sourceSha256: hash,
  payload: { "manifest.json": hash },
});
const proof = {
  signed: true,
  extensionId: EXTENSION_ID,
  version: "1.1.0",
  sha256: hash,
  firefoxVersion: "153.0",
  signedState: 2,
  signatureRequired: true,
  temporarilyInstalled: false,
  updateUrl: null,
};

describe("AMO version state", () => {
  it("preserves historical listed defaults and strictly validates new channel configuration", () => {
    expect(releaseChannel(null)).toBe("listed");
    expect(releaseChannel({ channel: "listed" })).toBe("listed");
    expect(releaseChannel({ channel: "unlisted" })).toBe("unlisted");
    for (const value of [undefined, {}, [], { channel: "unknown" }])
      expect(() => releaseChannel(value)).toThrow();
  });
  it("allows an approved unlisted file while the independent public listing is pending", () => {
    const nominated = { ...addon, status: "nominated", url: undefined };
    expect(
      amoState(nominated, { ...detail, channel: "unlisted" }, "1.1.0", "unlisted"),
    ).toMatchObject({ state: "approved", channel: "unlisted", listingUrl: "" });
    expect(amoState(nominated, detail, "1.1.0").state).toBe("pending");
    expect(() => amoState(nominated, detail, "1.1.0", "unlisted")).toThrow(/channel/);
  });
  it("keeps unlisted review pending and disabled files rejected", () => {
    for (const status of ["unreviewed", "disabled"]) {
      expect(
        amoState(
          addon,
          { ...detail, channel: "unlisted", file: { ...detail.file, status } },
          "1.1.0",
          "unlisted",
        ).state,
      ).toBe(status === "unreviewed" ? "pending" : "rejected");
    }
  });
  it("treats a URL and hash on an unreviewed file as pending", () => {
    expect(
      amoState(
        { ...addon, status: "nominated" },
        { ...detail, file: { ...detail.file, status: "unreviewed" } },
        "1.1.0",
      ),
    ).toEqual({ state: "pending", status: "unreviewed" });
  });
  it("accepts public ordinary AMO signing without confusing the internal-certificate flag", () => {
    expect(amoState(addon, detail, "1.1.0")).toMatchObject({
      state: "approved",
      internalCertificate: false,
      sha256: hash,
    });
  });
  it.each(["disabled", "deleted", "rejected"])("rejects add-on status %s", (status) => {
    expect(amoState({ ...addon, status }, detail, "1.1.0").state).toBe("rejected");
  });
  it("rejects author-disabled versions and disabled files", () => {
    expect(amoState(addon, { ...detail, is_disabled: true }, "1.1.0").state).toBe("rejected");
    expect(
      amoState(addon, { ...detail, file: { ...detail.file, status: "disabled" } }, "1.1.0").state,
    ).toBe("rejected");
  });
  it.each([
    { version: "1.0.0" },
    { channel: "unlisted" },
    { file: {} },
    { file: { ...detail.file, url: undefined } },
    { file: { ...detail.file, hash: undefined } },
    { file: { ...detail.file, status: "unknown" } },
  ])("rejects wrong/malformed version detail %j", (change) => {
    expect(() => amoState(addon, { ...detail, ...change }, "1.1.0")).toThrow();
  });
  it("rejects wrong extension ID and malformed add-ons", () => {
    for (const value of [null, [], {}, { ...addon, guid: "wrong" }])
      expect(() => amoState(value, detail, "1.1.0")).toThrow();
  });
  it("only an exact absent version permits submission", async () => {
    const post = vi.fn(async () => {});
    const approved = amoState(addon, detail, "1.1.0");
    expect(await ensureSubmission(async () => approved, post)).toEqual(approved);
    expect(post).not.toHaveBeenCalled();
    const query = vi.fn().mockResolvedValueOnce({ state: "absent" }).mockResolvedValue(approved);
    await ensureSubmission(query, post);
    expect(post).toHaveBeenCalledTimes(1);
    await ensureSubmission(query, post);
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("does not resubmit rejected versions or claim absent post-submit versions accepted", async () => {
    const post = vi.fn(async () => {});
    await expect(
      ensureSubmission(async () => ({ state: "rejected", status: "disabled" }), post),
    ).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
    await expect(ensureSubmission(async () => ({ state: "absent" }), post)).rejects.toThrow(
      /did not accept/,
    );
  });
});

describe("Mozilla download trust", () => {
  it.each([
    "http://addons.mozilla.org/a",
    "https://evil.example/a",
    "https://addons.mozilla.org.evil.example/a",
    "https://user:password@addons.mozilla.org/a",
    "https://addons.mozilla.org:444/a",
  ])("rejects untrusted URL %s", (url) => expect(() => mozillaUrl(url)).toThrow());
  it("verifies SHA-256 and never sends authorization on downloads", async () => {
    const bytes = Buffer.from("download fixture");
    const fetcher = vi.fn(
      async (_url: string | URL | Request, _options?: RequestInit) => new Response(bytes),
    );
    expect(await downloadSigned(detail.file.url, sha256(bytes), fetcher)).toEqual(bytes);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toBeUndefined();
    await expect(downloadSigned(detail.file.url, hash, fetcher)).rejects.toThrow(
      /SHA-256 mismatch/,
    );
  });
  it("bounds and validates redirects", async () => {
    const foreign = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }),
    );
    await expect(downloadSigned(detail.file.url, hash, foreign)).rejects.toThrow(/Untrusted/);
    expect(foreign).toHaveBeenCalledTimes(1);
    const loop = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: detail.file.url } }),
    );
    await expect(downloadSigned(detail.file.url, hash, loop)).rejects.toThrow(/Too many/);
    expect(loop).toHaveBeenCalledTimes(4);
  });
});

describe("release provenance and publication guard", () => {
  it("binds an unlisted release to the exact submission channel and Firefox proof", () => {
    const unlisted = parseSubmission({ ...submission, channel: "unlisted" });
    const state = amoState(addon, { ...detail, channel: "unlisted" }, "1.1.0", "unlisted");
    expect(distributionMetadata(unlisted, state, proof)).toMatchObject({
      channel: "unlisted",
      mozillaSigned: true,
    });
    expect(sameSubmission(submission, unlisted)).toBe(false);
    expect(() => distributionMetadata(submission, state, proof)).toThrow();
    expect(() => distributionMetadata(unlisted, state, { ...proof, signed: false })).toThrow();
    expect(() => parseSubmission({ ...unlisted, channel: "unknown" })).toThrow();
  });
  it("describes self-distribution without claiming public listing approval or GitHub updates", () => {
    const notes = formatGithubReleaseBody([], "unlisted");
    expect(notes).toContain("unlisted");
    expect(notes).toContain("not a public AMO listing approval");
    expect(notes).toContain("GitHub releases do not automatically update");
  });
  it("records signed-XPI hash, source hash and Firefox signature evidence", () => {
    const metadata = distributionMetadata(submission, amoState(addon, detail, "1.1.0"), proof);
    expect(metadata).toMatchObject({
      mozillaSigned: true,
      commit: submission.commit,
      signedXpi: { name: "net-identity-1.1.0-firefox-signed.xpi", sha256: hash },
      amo: { reportedSha256: hash, isMozillaInternalCertificate: false },
      source: { sha256: hash },
    });
  });
  it.each([
    { signed: false },
    { signatureRequired: false },
    { temporarilyInstalled: true },
    { signedState: 0 },
    { sha256: "b".repeat(64) },
    { extensionId: "wrong" },
    { updateUrl: "https://elsewhere.example/" },
    { firefoxVersion: "154.0b1" },
  ])("cannot finalize with invalid Firefox proof %j", (change) => {
    expect(() =>
      distributionMetadata(submission, amoState(addon, detail, "1.1.0"), { ...proof, ...change }),
    ).toThrow();
  });
  it("cannot finalize pending approval or unaccepted submission", () => {
    expect(() =>
      distributionMetadata(submission, { state: "pending", status: "unreviewed" }, proof),
    ).toThrow();
    expect(() =>
      distributionMetadata(
        { ...submission, accepted: false },
        amoState(addon, detail, "1.1.0"),
        proof,
      ),
    ).toThrow();
  });
  it("reruns require identical tag, commit, source and tested payload", () => {
    expect(sameSubmission(submission, parseSubmission(submission))).toBe(true);
    expect(sameSubmission(submission, { ...submission, commit: "c".repeat(40) })).toBe(false);
    expect(
      sameSubmission(submission, { ...submission, payload: { "manifest.json": "c".repeat(64) } }),
    ).toBe(false);
  });
  it("protects immutable v1.0.0 and rejects tag injection and malformed records", () => {
    expect(LISTED_110_COMMIT).toBe("e257b057a3c93e8b90fbd8de792429af2202ea35");
    expect(HISTORICAL_COMMIT).toBe("e3f8b22ed08e2acc13e93aad180b2e4e28f69325");
    for (const tag of ["v1.0.0", "v0.9.0", "main", "v1.1.0;echo", "v01.1.0"])
      expect(() => releaseVersion(tag)).toThrow();
    for (const value of [
      null,
      {},
      { ...submission, tag: "v1.0.0" },
      { ...submission, payload: {} },
      { ...submission, sourceSha256: "bad" },
    ])
      expect(() => parseSubmission(value)).toThrow();
  });
});
