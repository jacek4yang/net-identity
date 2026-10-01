import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { hardenMapLibreWorker } from "../scripts/maplibre-vendor.mjs";

const source = readFileSync(
  new URL("../node_modules/maplibre-gl/dist/maplibre-gl-worker-dev.mjs", import.meta.url),
  "utf8",
);
describe("patched MapLibre worker", () => {
  it("removes exactly the complete external plugin loader from the reviewed upstream source", () => {
    const patched = hardenMapLibreWorker(source);
    expect(patched).not.toMatch(/\beval\s*\(/);
    const loader = patched.slice(
      patched.indexOf("async function loadScript("),
      patched.indexOf("\n}\n", patched.indexOf("async function loadScript(")) + 2,
    );
    expect(loader).toContain("External MapLibre worker plugins are disabled");
    expect(loader).not.toMatch(/\b(?:fetch|import|eval)\s*\(/);
    expect(patched).toContain('from "./maplibre-gl-shared-dev.mjs"');
  });
  it("rejects all unreviewed or duplicate-loader upstream inputs", () => {
    expect(() => hardenMapLibreWorker(source + "\n")).toThrow("Unreviewed");
    expect(() => hardenMapLibreWorker(source + source)).toThrow("Unreviewed");
    expect(() =>
      hardenMapLibreWorker(
        source.replace("async function loadScript", "async function otherScript"),
      ),
    ).toThrow("Unreviewed");
  });
  it("the replacement rejects classic and module plugins without fetching or evaluating code", async () => {
    const replacement = readFileSync(
      new URL("../scripts/vendor/maplibre-worker-loader.disabled.txt", import.meta.url),
      "utf8",
    );
    for (const url of [
      "https://example.com/plugin.js",
      "https://example.com/plugin.mjs",
      "blob:plugin",
      "moz-extension://example/plugin.js",
    ])
      await expect(
        runInNewContext(`${replacement}; loadScript(${JSON.stringify(url)})`) as Promise<void>,
      ).rejects.toThrow("External MapLibre worker plugins are disabled");
  });
  it("uses the upstream static attribute snapshot fix for GHSA-jrc7-96c5-q579", () => {
    const dom = readFileSync(
      new URL("../node_modules/maplibre-gl/src/util/dom.ts", import.meta.url),
      "utf8",
    );
    expect(dom).toContain("for (const name of getAttributeNames.call(element))");
    expect(dom).toContain("public static sanitize(str: string): DocumentFragment");
    expect(dom).not.toMatch(/for\s*\([^)]*\.attributes\)/);
  });
});
