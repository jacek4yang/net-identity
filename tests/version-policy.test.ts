import { describe, expect, it } from "vitest";
import { checkReleaseVersion, formatReleaseNotes } from "../src/release/version";

const current = {
  packageVersion: "0.2.0",
  manifestVersion: "0.2.0",
  extensionId: "net-identity@jacek4yang.github.io",
};

describe("release version policy", () => {
  it("accepts a clean matching tag that is newer than what shipped", () => {
    expect(
      checkReleaseVersion({
        ...current,
        tag: "v0.2.0",
        previousVersions: ["0.1.0"],
        dirty: false,
        requireClean: true,
      }),
    ).toEqual({ ok: true, version: "0.2.0" });
  });

  it("rejects a mismatched tag, a dirty tree, a downgrade, and a repeat", () => {
    const mismatched = checkReleaseVersion({ ...current, tag: "v0.1.0" });
    expect(mismatched.ok).toBe(false);

    const dirty = checkReleaseVersion({ ...current, dirty: true, requireClean: true });
    expect(dirty.ok).toBe(false);

    const downgraded = checkReleaseVersion({ ...current, previousVersions: ["0.3.0"] });
    expect(downgraded.ok).toBe(false);

    const duplicate = checkReleaseVersion({ ...current, previousVersions: ["0.2.0"] });
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
});
