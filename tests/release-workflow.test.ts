import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/release.yml", "utf8");
const finalize = readFileSync(".github/workflows/amo-finalize.yml", "utf8");
const control = readFileSync("scripts/release-control.mjs", "utf8");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const firefox = readFileSync(".github/workflows/firefox-invariants.yml", "utf8");

describe("two-phase AMO publication", () => {
  it("selects listed distribution for the next release without changing channel support", () => {
    expect(JSON.parse(readFileSync("release-config.json", "utf8"))).toEqual({ channel: "listed" });
  });
  it("submits only from version tags after both complete gates", () => {
    expect(workflow).toContain('"v[0-9]+.[0-9]+.[0-9]+"');
    expect(workflow).toContain(
      "if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
    );
    expect(workflow).toContain("needs: [quality, firefox]");
    expect(workflow).toContain("uses: ./.github/workflows/firefox-invariants.yml");
    for (const command of ["npm ci", "npm run check", "npm run package"])
      expect(workflow).toContain(command);
    for (const command of [
      "e2e:invariants",
      "e2e:websocket",
      "e2e:proxy-auth",
      "e2e:ui",
      "e2e:fail-closed",
      "e2e:restart",
      "e2e:socks-auth",
    ])
      expect(firefox).toContain(command);
  });
  it("phase one cannot finalize a release", () => {
    expect(workflow).toContain("release-control.mjs submit");
    expect(workflow).not.toContain("release-control.mjs publish");
    expect(workflow).not.toContain("gh release create");
    expect(control).toContain('"--draft"');
  });
  it("uses API v5 configured-channel submission with metadata and exact source", () => {
    for (const text of [
      "https://addons.mozilla.org/api/v5/",
      "--channel=${channel}",
      "--amo-metadata",
      "--upload-source-code",
      "--approval-timeout",
    ])
      expect(control).toContain(text);
    expect(control).toContain("const channel = releaseChannel(");
    expect(finalize).toContain("channel: [listed, unlisted]");
    expect(finalize).toContain("SELECT_CHANNEL: ${{ matrix.channel }}");
    expect(workflow).toContain("gh workflow run amo-finalize.yml --ref main");
    expect(control).not.toMatch(/api\/v[34]\//);
  });
  it("never grants AMO secrets to pull requests", () => {
    expect(ci).not.toMatch(/AMO_JWT|WEB_EXT_API/);
    expect(firefox).not.toMatch(/AMO_JWT|WEB_EXT_API/);
    expect(finalize).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).not.toContain("pull_request");
    expect(finalize).not.toContain("pull_request");
  });
  it("polls hourly and on dispatch without holding a review-waiting job", () => {
    expect(finalize).toContain('cron: "23 * * * *"');
    expect(finalize).toContain("workflow_dispatch:");
    expect(finalize).toContain("timeout-minutes: 15");
    expect(finalize).toContain("steps.prepare.outputs.approved == 'true'");
  });
  it("serializes submission and finalization and checks an immutable tag", () => {
    expect(workflow).toContain("group: amo-distribution");
    expect(finalize).toContain("group: amo-distribution");
    expect(finalize).toContain("ref: ${{ steps.select.outputs.commit }}");
    expect(finalize).toContain("path: release-tag");
    expect(finalize).toContain("working-directory: release-tag");
    expect(finalize).toContain("../scripts/release-control.mjs prepare");
    expect(finalize).toContain("../scripts/release-control.mjs publish");
    expect(control).toContain('"--is-ancestor"');
    expect(control).toContain("HISTORICAL_COMMIT");
  });
  it("finalizes only after normal Firefox signature verification", () => {
    expect(finalize.indexOf("verify-firefox-signature.mjs")).toBeLessThan(
      finalize.indexOf("release-control.mjs publish"),
    );
    expect(control).toContain("distributionMetadata(submission, state");
    expect(control).toContain("verifySignedPayload(bytes, version, submission.payload)");
    expect(control).toContain("SHA256SUMS.txt");
    expect(control).toContain("release-metadata.json");
  });
  it("retains only hash-verified download diagnostics when prepare fails, without publishing them", () => {
    expect(finalize).toContain("failure() && steps.prepare.outcome == 'failure'");
    expect(finalize).toContain("release-tag/artifacts/release/amo-download-diagnostic.*");
    expect(control.indexOf('file("amo-download-diagnostic.xpi")')).toBeGreaterThan(
      control.indexOf("await downloadSigned(state.url, state.sha256"),
    );
    expect(control.slice(control.indexOf('if (mode !== "publish")'))).not.toContain(
      "amo-download-diagnostic",
    );
  });
  it("does not expose raw signing-client output or duplicate-message heuristics", () => {
    expect(control).not.toMatch(/console\.(log|error)\([^)]*(stdout|stderr|API_KEY|API_SECRET)/);
    expect(control).not.toContain("/already exists");
    expect(control).toContain("ensureSubmission");
  });
  it("reruns verify public artifacts without modifying historical releases", () => {
    expect(control).toContain("Existing signed release verified without changes");
    expect(control).toContain("sameSubmission(submission, fresh)");
    expect(control).not.toContain('"--force"');
    expect(control).not.toContain('"tag", "-f"');
  });
});
