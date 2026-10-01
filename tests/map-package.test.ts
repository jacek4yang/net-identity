import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
describe("locally packaged map security contract", () => {
  it("blocks direct network in the options renderer and keeps worker code local", () => {
    const html = read("src/options/options.html");
    const renderer = read("src/options/online-map.ts");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain('href="maplibre.css"');
    expect(renderer).toContain('extensionUrl("options/maplibre-worker.js")');
    expect(renderer).toContain("attributionControl: false");
    expect(renderer).toContain("localIdeographFontFamily: false");
    expect(renderer).not.toMatch(/\.innerHTML\s*=|new\s+(?:Popup|ScaleControl)\b|\.setHTML\(/);
    expect(renderer).not.toMatch(/\bfetch\s*\(/);
  });
  it("draws the decorative Off icon without requiring a system-font glyph", () => {
    const popup = read("src/popup/popup.html");
    const offButton = popup.split('id="route-off"')[1]?.split("</button>")[0] ?? "";
    expect(offButton).toContain('role="radio"');
    expect(offButton).toContain('aria-checked="true"');
    expect(offButton).toContain('class="route-lead" aria-hidden="true"');
    expect(offButton).toContain("<svg");
    expect(offButton).toContain('focusable="false"');
    expect(offButton).toContain('class="route-name">Off</span>');
    expect(offButton).not.toContain("⏻");
    expect(offButton).not.toMatch(/(?:href|src)=/);
  });
  it("pins upstream bytes and does not suppress unsafe vendor DOM warnings", () => {
    const build = read("scripts/build.mjs");
    const lint = read("scripts/lint-extension.mjs");
    expect(build).toContain("MAPLIBRE_ASSET_HASHES");
    expect(build).toContain('createHash("sha256")');
    expect(build).toContain("await verifyMapLibreVendor()");
    expect(lint).not.toContain("UNSAFE_VAR_ASSIGNMENT");
    expect(build).toContain("hardenMapLibreWorker");
    const packageVerifier = read("scripts/verify-artifacts.mjs");
    for (const file of [
      "options/maplibre.js",
      "options/maplibre-worker.js",
      "options/maplibre.css",
      "licenses/maplibre-LICENSE.txt",
      "licenses/maplibre-dependencies.txt",
    ])
      expect(packageVerifier).toContain(file);
  });
  it("refuses test certificates and private keys in release artifacts", () => {
    const source = read("scripts/verify-artifacts.mjs");
    const declaration = source.split("const REQUIRED_ENTRIES = [")[1]?.split("];")[0] ?? "";
    const required = [...declaration.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(required.length).toBeGreaterThan(15);
    const names = [
      ...required,
      "fixture-ca.pem",
      "server.KEY",
      "root.crt",
      "root.cer",
      "bundle.p12",
      "bundle.pfx",
      "request.csr",
      "serial.srl",
    ];
    const central = names.map((name) => {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(Buffer.byteLength(name), 28);
      return Buffer.concat([header, Buffer.from(name)]);
    });
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(names.length, 10);
    const directory = mkdtempSync(path.join(tmpdir(), "ni-package-guard-"));
    try {
      writeFileSync(path.join(directory, "fixture.zip"), Buffer.concat([...central, end]));
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../scripts/verify-artifacts.mjs", import.meta.url)),
          "--artifacts-dir",
          directory,
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      for (const name of names.slice(required.length)) expect(result.stderr).toContain(name);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
