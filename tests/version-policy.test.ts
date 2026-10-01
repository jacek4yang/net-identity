import { describe, expect, it } from "vitest";
import {
  checkReleaseVersion,
  formatGithubReleaseBody,
  formatReleaseNotes,
} from "../src/release/version";

const current = {
  packageVersion: "1.1.4",
  manifestVersion: "1.1.4",
  extensionId: "net-identity@jacek4yang.github.io",
};

describe("release version policy", () => {
  it("accepts a clean matching tag that is newer than what shipped", () => {
    expect(
      checkReleaseVersion({
        ...current,
        tag: "v1.1.4",
        previousVersions: ["1.0.0", "1.1.0", "1.1.1", "1.1.2", "1.1.3"],
        dirty: false,
        requireClean: true,
      }),
    ).toEqual({ ok: true, version: "1.1.4" });
  });

  it("rejects a mismatched tag, a dirty tree, a downgrade, and a repeat", () => {
    const mismatched = checkReleaseVersion({ ...current, tag: "v1.1.1" });
    expect(mismatched.ok).toBe(false);

    const dirty = checkReleaseVersion({ ...current, dirty: true, requireClean: true });
    expect(dirty.ok).toBe(false);

    const downgraded = checkReleaseVersion({ ...current, previousVersions: ["1.2.0"] });
    expect(downgraded.ok).toBe(false);

    const duplicate = checkReleaseVersion({ ...current, previousVersions: ["1.1.4"] });
    expect(duplicate.ok).toBe(false);

    const malformed = checkReleaseVersion({ ...current, packageVersion: "0.2" });
    expect(malformed.ok).toBe(false);

    const retitled = checkReleaseVersion({
      ...current,
      extensionId: "other@example.com",
    });
    expect(retitled.ok).toBe(false);
  });

  it("writes release notes only from the supplied pull requests", () => {
    expect(formatReleaseNotes([])).toBe("No pull requests were provided for these notes.\n");
    expect(formatReleaseNotes([{ number: 42, title: "fix: remember the snapshot" }])).toBe(
      "- #42 fix: remember the snapshot\n",
    );
    expect(() => formatReleaseNotes([{ number: 1, title: "" }])).toThrow(/title/);
  });

  it("describes the signed installer and canonical AMO update channel", () => {
    const body = formatGithubReleaseBody([{ number: 44, title: "feat: check versions" }]);
    expect(body).toContain("canonical public distribution and automatic-update channel");
    expect(body).toContain("Mozilla-signed XPI");
    expect(body).toContain("#44 feat: check versions");
  });
});
