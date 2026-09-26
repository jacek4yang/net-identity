import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/release.yml", "utf8");
const submit = readFileSync("scripts/submit-listed.mjs", "utf8");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");

describe("AMO listed publication", () => {
  it("only runs for a version tag, never for a pull request", () => {
    expect(workflow).toContain('"v[0-9]+.[0-9]+.[0-9]+"');
    expect(workflow).not.toContain("pull_request");
    expect(workflow).toContain(
      "if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
    );
  });

  it("submits only after the quality job and the real-Firefox gate", () => {
    expect(workflow).toContain("needs: [quality, firefox]");
    expect(workflow).toContain("uses: ./.github/workflows/firefox-invariants.yml");
  });

  it("reads the AMO credentials only from the tag workflow", () => {
    expect(workflow).toContain("secrets.AMO_JWT_ISSUER");
    expect(workflow).toContain("secrets.AMO_JWT_SECRET");
    expect(workflow).toContain("WEB_EXT_API_KEY");
    expect(workflow).toContain("WEB_EXT_API_SECRET");
    // No pull-request workflow may reach an AMO secret.
    expect(ci).not.toContain("AMO_JWT");
    expect(ci).not.toContain("WEB_EXT_API");
  });

  it("uses least permissions and submits on the listed channel with source", () => {
    expect(workflow).toContain("contents: read");
    expect(submit).toContain("--channel=listed");
    expect(submit).toContain("--amo-metadata");
    expect(submit).toContain("--upload-source-code");
    expect(submit).toContain("--approval-timeout");
  });

  it("publishes a GitHub Release only after checks, the browser gate and AMO submission", () => {
    expect(workflow).toContain("needs: [quality, firefox, submit]");
    // Writing releases is scoped to the publish job; the workflow default stays read.
    expect(workflow).toContain("contents: read");
    expect(workflow).toMatch(/publish:[\s\S]*contents: write/);
  });

  it("attaches the package, source, checksums and machine-readable metadata", () => {
    expect(workflow).toContain("write-metadata.ts");
    expect(workflow).toContain("write-notes.ts");
    expect(workflow).toContain("SHA256SUMS.txt");
    expect(workflow).toContain("release-metadata.json");
    expect(workflow).toContain("--notes-file release.md");
  });

  it("makes a rerun for an existing tag safe", () => {
    expect(workflow).toMatch(/gh release create/);
    expect(workflow).toMatch(/gh release upload[\s\S]*--clobber/);
    expect(workflow).toMatch(/gh release edit/);
  });

  it("never prints credential material", () => {
    expect(submit).not.toMatch(/console\.(log|error)\([^)]*(API_KEY|API_SECRET)/);
  });

  it("treats a duplicate version as success so a rerun is idempotent", () => {
    expect(submit).toMatch(/already exists/i);
    expect(submit).toContain("process.exit(0)");
  });
});
