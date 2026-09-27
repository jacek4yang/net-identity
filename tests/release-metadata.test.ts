import { describe, expect, it } from "vitest";
import { buildReleaseMetadata, formatChecksums, RELEASE_NAME } from "../src/release/metadata";
import { EXTENSION_ID } from "../src/release/version";

const SHA = "a".repeat(64);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const base = { version: "1.1.0", tag: "v1.1.0", commit: COMMIT, channel: "listed" } as const;

describe("release metadata", () => {
  it("ties the version, tag, commit, extension id and artifacts together", () => {
    const metadata = buildReleaseMetadata({
      ...base,
      artifacts: [{ name: "net-identity-1.1.0-firefox-signed.xpi", sha256: SHA }],
    });
    expect(metadata.name).toBe(RELEASE_NAME);
    expect(metadata.extensionId).toBe(EXTENSION_ID);
    expect(metadata.tag).toBe("v1.1.0");
    expect(metadata.artifacts).toEqual([
      { name: "net-identity-1.1.0-firefox-signed.xpi", sha256: SHA },
    ]);
  });

  it("rejects a tag that disagrees with the version", () => {
    expect(() =>
      buildReleaseMetadata({ ...base, tag: "v1.1.1", artifacts: [{ name: "x.zip", sha256: SHA }] }),
    ).toThrow(/must be v1.1.0/);
  });

  it("rejects a bad commit, channel, empty artifact list and bad hash or name", () => {
    const artifact = { name: "x.zip", sha256: SHA };
    expect(() => buildReleaseMetadata({ ...base, commit: "nope", artifacts: [artifact] })).toThrow(
      /git object id/,
    );
    expect(() =>
      buildReleaseMetadata({ ...base, channel: "unknown", artifacts: [artifact] }),
    ).toThrow(/channel/);
    expect(() => buildReleaseMetadata({ ...base, artifacts: [] })).toThrow(/at least one/);
    expect(() =>
      buildReleaseMetadata({ ...base, artifacts: [{ name: "x.zip", sha256: "ABC" }] }),
    ).toThrow(/sha256/);
    expect(() =>
      buildReleaseMetadata({ ...base, artifacts: [{ name: " ", sha256: SHA }] }),
    ).toThrow(/name/);
  });

  it("formats a sha256sum-compatible checksum file", () => {
    expect(
      formatChecksums([
        { name: "a.zip", sha256: SHA },
        { name: "b.zip", sha256: "b".repeat(64) },
      ]),
    ).toBe(`${SHA}  a.zip\n${"b".repeat(64)}  b.zip\n`);
  });
});
