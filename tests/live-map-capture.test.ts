import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = () => readFileSync(".github/workflows/capture-live-map.yml", "utf8");

describe("optional real-provider listing capture", () => {
  it("bounds Mesa threads for rendering, listing and bilingual review capture", () => {
    expect(workflow().match(/LP_NUM_THREADS: "2"/g)).toHaveLength(3);
  });
  it("keeps store-sized images separate from bilingual light/dark review evidence", () => {
    const source = workflow();
    expect(source).toContain("for theme in dark light");
    expect(source).toContain("--live-map --review --screenshots");
    expect(source).toContain("--draft-check --draft-evidence artifacts/draft-review");
    expect(source).toContain("candidate-bilingual-review");
    const capture = readFileSync("scripts/e2e-ui.mjs", "utf8");
    expect(capture).toContain('for (const language of ["zh_CN", "en"])');
    expect(capture).toContain('theme: values.light ? "light" : "dark"');
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

  it("requires CJK and Sinhala capture fonts and bounds external package setup", () => {
    expect(workflow()).toContain("fonts-noto-cjk");
    expect(workflow()).toContain("fc-list :lang=zh family");
    expect(workflow()).toContain("fonts-noto-core");
    expect(workflow()).toContain("fc-list :lang=si family");
    expect(workflow()).toContain("test -s artifacts/capture-fonts/sinhala.txt");
    expect(workflow()).toContain("artifacts/capture-fonts/*");
    const gate = readFileSync("scripts/e2e-map.mjs", "utf8");
    expect(gate).toContain("await isolateLatinFonts(directory)");
    expect(gate).toContain("CJK U+65E5 coverage absent");
    expect(workflow()).toContain("timeout-minutes: 8");
    expect(workflow()).toContain("Acquire::https::Timeout=30");
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

  it("selects HTTP for the CONNECT-only live fixture instead of the new SOCKS default", () => {
    expect(readFileSync("scripts/e2e-ui.mjs", "utf8")).toContain(
      '"field-proxy-type": liveMap ? "http" : "socks5"',
    );
    expect(readFileSync("scripts/live-map-proxy.mjs", "utf8")).toContain('server.on("connect"');
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
