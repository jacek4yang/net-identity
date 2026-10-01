import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertAmoMetadata } from "../src/release/amo-metadata";
import { EXTENSION_ID } from "../src/release/version";

const metadata = (notes: unknown, summary: unknown = "Network identity manager") => ({
  summary: { "en-US": summary },
  version: { approval_notes: notes },
});

describe("AMO metadata text limits", () => {
  it.each(["a", "界", "🦊"])("accepts 3000 and rejects 3001 %s characters", (character) => {
    expect(() => assertAmoMetadata(metadata(character.repeat(3000)))).not.toThrow();
    expect(() => assertAmoMetadata(metadata(character.repeat(3001)))).toThrow(
      /version\.approval_notes has 3001 characters; maximum is 3000/,
    );
  });

  it("counts combining marks separately and does not trim submitted text", () => {
    expect(() => assertAmoMetadata(metadata("e\u0301".repeat(1500)))).not.toThrow();
    expect(() => assertAmoMetadata(metadata(`${"e\u0301".repeat(1500)} `))).toThrow(
      /maximum is 3000/,
    );
  });

  it.each([undefined, null, 123, true, {}, [], "", " \n\t"])(
    "rejects malformed approval notes %j",
    (notes) => {
      expect(() => assertAmoMetadata(metadata(notes))).toThrow(
        /version\.approval_notes must be a non-empty string/,
      );
    },
  );

  it.each([undefined, null, [], "notes", {}])("rejects malformed metadata %j", (value) => {
    expect(() => assertAmoMetadata(value)).toThrow(/AMO metadata/);
    expect(() => assertAmoMetadata({ summary: { "en-US": "Summary" }, version: value })).toThrow(
      /AMO metadata version/,
    );
  });

  it("preserves the 250-character summary limit for every supplied locale", () => {
    expect(() => assertAmoMetadata(metadata("Review notes", "🦊".repeat(250)))).not.toThrow();
    expect(() => assertAmoMetadata(metadata("Review notes", "a".repeat(251)))).toThrow(
      /summary\.en-US has 251 characters; maximum is 250/,
    );
    expect(() =>
      assertAmoMetadata({
        ...metadata("Review notes"),
        summary: { "en-US": "Summary", pl: "a".repeat(251) },
      }),
    ).toThrow(/summary\.pl has 251 characters; maximum is 250/);
  });

  it.each([undefined, null, 123, {}, [], "", " "])("rejects malformed summary %j", (summary) => {
    expect(() =>
      assertAmoMetadata({ summary: { "en-US": summary }, version: { approval_notes: "Notes" } }),
    ).toThrow(/summary\.en-US must be a non-empty string/);
  });
});

describe("check:version AMO metadata gate", () => {
  it.each([3000, 3001])("checks %i-character notes before allowing a release", (length) => {
    const root = mkdtempSync(path.join(tmpdir(), "net-identity-metadata-"));
    try {
      mkdirSync(path.join(root, "src/release"), { recursive: true });
      mkdirSync(path.join(root, "public"));
      for (const file of ["check-version.ts", "version.ts", "amo-metadata.ts"])
        copyFileSync(`src/release/${file}`, path.join(root, "src/release", file));
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ type: "module", version: "1.1.0" }),
      );
      writeFileSync(
        path.join(root, "public/manifest.json"),
        JSON.stringify({
          version: "1.1.0",
          browser_specific_settings: { gecko: { id: EXTENSION_ID } },
        }),
      );
      writeFileSync(
        path.join(root, "amo-metadata.json"),
        JSON.stringify(metadata("🦊".repeat(length))),
      );
      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "src/release/check-version.ts"],
        {
          cwd: root,
          env: { ...process.env, GITHUB_REF: "refs/tags/v1.1.0", PUBLISHED_VERSIONS: "" },
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(length === 3000 ? 0 : 1);
      expect(result.stderr).toContain(
        length === 3000
          ? "version 1.1.0 matches the manifest and extension id"
          : "AMO metadata version.approval_notes has 3001 characters; maximum is 3000",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
