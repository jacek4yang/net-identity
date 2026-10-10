import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const firefox = readFileSync(".github/workflows/firefox-invariants.yml", "utf8");

describe("real-Firefox release gate", () => {
  it("pins installer names independently of localized display names", () => {
    const metadata = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(metadata.scripts.package).toContain("--filename net-identity-{version}.zip");
    expect(firefox).toContain("--filename net-identity-{version}.zip");
    expect(firefox).toContain('--xpi "artifacts/net-identity-$version.zip"');
    expect(firefox).toContain("--expect-unsigned");
  });
  it("runs the deterministic Firefox invariants as a separate CI job", () => {
    expect(ci).toContain("uses: ./.github/workflows/firefox-invariants.yml");
    expect(firefox).toContain("workflow_call");
    expect(firefox).toContain("run invariants npm run e2e:invariants");
    expect(firefox).toContain("run websocket npm run e2e:websocket");
    expect(firefox).toContain("run ui npm run e2e:ui");
    expect(firefox).toContain("run draft npm run e2e:draft");
    expect(firefox).toContain("run fail-closed npm run e2e:fail-closed");
    expect(firefox).toContain("run flap npm run e2e:flap");
    expect(firefox).toContain("run restart npm run e2e:restart");
    expect(firefox).toContain("run socks-auth npm run e2e:socks-auth");
  });

  it("requires actual MapLibre WebGL rendering separately from the fallback", () => {
    expect(firefox).toContain("run: npm run build:prod");
    expect(firefox).not.toMatch(/run: npm run build\s*\n/);
    expect(firefox).toContain("openssl libnss3-tools xvfb libgl1-mesa-dri");
    expect(firefox).toContain("fontconfig fonts-dejavu-core");
    expect(firefox).toContain("--no-local-cjk --screenshots artifacts/map-render");
    expect(firefox).toContain("run map-fallback npm run e2e:map-fallback");
    expect(firefox).toContain(
      "run map-render env -u MOZ_HEADLESS LIBGL_ALWAYS_SOFTWARE=1 LP_NUM_THREADS=2 xvfb-run -a npm run e2e:map",
    );
    expect(firefox).toContain("--screenshots artifacts/map-render");
    expect(firefox).toContain("artifacts/map-render/*");
    const harness = readFileSync("scripts/e2e-map.mjs", "utf8");
    expect(harness).toContain("if (!productionBundle)");
    expect(harness).toContain("sourceMapsPresent.length === 0");
    expect(harness).toContain("requires npm run build:prod");
    expect(harness).not.toContain("productionBundle: true");
  });

  it("runs authenticated proxy validation with a local offline fixture", () => {
    expect(firefox).toContain("run proxy-auth npm run e2e:proxy-auth");
    expect(readFileSync("scripts/e2e-proxy-auth.mjs", "utf8")).toContain('"--offline"');
  });

  it("keeps the public GeoIP smoke test out of the release gate", () => {
    expect(firefox).not.toContain("e2e-smoke");
    expect(firefox).not.toContain("ipwho.is");
  });

  it("uses least permissions and captures logs on failure", () => {
    expect(firefox).toContain("contents: read");
    expect(firefox).toContain("if: failure()");
    expect(firefox).toContain("actions/upload-artifact@");
  });

  it("does not run the browser gate on pull requests from forks with secrets", () => {
    // The gate must not reference a secret; only the tag workflow reads AMO credentials.
    expect(firefox).not.toContain("secrets.");
  });
});
