import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = () => readFileSync(".github/workflows/capture-live-map.yml", "utf8");

describe("optional real-provider listing capture", () => {
  it("bounds Mesa threads for both production rendering and live capture", () => {
    expect(workflow().match(/LP_NUM_THREADS: "2"/g)).toHaveLength(2);
  });
  it("requires a manual opt-in and grants no write credentials", () => {
    const source = workflow();
    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain(
      "github.event_name == 'workflow_dispatch' && inputs.capture_public_map",
    );
    expect(source).toContain("types: [labeled]");
    expect(source).toContain("github.event.label.name == 'preview-real-map'");
    expect(source).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(source).toContain("ref: ${{ github.event.pull_request.head.sha || github.sha }}");
    expect(source).toContain("default: false");
    expect(source).toContain("contents: read");
    expect(source).toContain("persist-credentials: false");
    expect(source).not.toMatch(/pull_request_target:|push:|schedule:|secrets\./);
  });

  it("requires deterministic actual rendering before requesting public map data", () => {
    const source = workflow();
    const build = source.indexOf("npm run build:prod");
    const render = source.indexOf("node scripts/e2e-map.mjs");
    const capture = source.indexOf("node scripts/e2e-ui.mjs");
    expect(build).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(build);
    expect(capture).toBeGreaterThan(render);
    expect(source).toContain("--live-map --screenshots artifacts/listing-map");
    expect(source).not.toContain("--no-webgl");
    expect(source).not.toContain("continue-on-error");
    expect(readFileSync(".github/workflows/firefox-invariants.yml", "utf8")).not.toContain(
      "--live-map",
    );
  });

  it("exports candidate evidence without replacing or publishing existing assets", () => {
    const source = workflow();
    expect(source).toContain("candidate-real-map-listing");
    expect(source).toContain("source-commit.txt");
    expect(source).not.toContain("store-assets/screenshots");
    const guide = readFileSync("store-assets/REAL-MAP-CAPTURE.md", "utf8");
    expect(guide).toContain("requires visual review");
    expect(guide).toContain("network-visible IP");
    const capture = readFileSync("scripts/e2e-ui.mjs", "utf8");
    expect(capture.indexOf("Live map became incomplete during capture")).toBeGreaterThan(
      capture.indexOf("mapRequestEvidence = await readMapRequestEvidence(true)"),
    );
  });

  it("passes the network-free proxy rejection and lifecycle regressions", () => {
    execFileSync(process.execPath, ["--test", "scripts/live-map-proxy.test.mjs"], {
      encoding: "utf8",
      timeout: 25000,
      maxBuffer: 1024 * 1024,
    });
  }, 30000);
});
