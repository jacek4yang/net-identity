import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const sizes = [16, 32, 48, 64, 96, 128];
function icon(size: number): Buffer {
  return readFileSync(new URL(`../public/icons/icon-${size}.png`, import.meta.url));
}
describe("original route shield assets", () => {
  it("regenerates every committed PNG and SVG byte-for-byte", () => {
    const before = sizes.map(icon);
    const svg = readFileSync(new URL("../store-assets/icons/icon.svg", import.meta.url));
    execFileSync(process.execPath, ["scripts/make-icons.mjs"]);
    sizes.forEach((size, index) => expect(icon(size)).toEqual(before[index]));
    expect(readFileSync(new URL("../store-assets/icons/icon.svg", import.meta.url))).toEqual(svg);
  });
  it.each(sizes)("has %ipx RGBA dimensions and antialiased transparent surroundings", (size) => {
    const png = icon(size);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
    expect(png[25]).toBe(6);
    const compressed: Buffer[] = [];
    for (let pos = 8; pos < png.length;) {
      const length = png.readUInt32BE(pos);
      if (png.toString("ascii", pos + 4, pos + 8) === "IDAT")
        compressed.push(png.subarray(pos + 8, pos + 8 + length));
      pos += length + 12;
    }
    const raw = inflateSync(Buffer.concat(compressed));
    const alphas: number[] = [];
    for (let y = 0; y < size; y++) {
      expect(raw[y * (size * 4 + 1)]).toBe(0);
      for (let x = 0; x < size; x++) alphas.push(raw[y * (size * 4 + 1) + 1 + x * 4 + 3] ?? -1);
    }
    expect(alphas[0]).toBe(0);
    expect(alphas).toContain(255);
    expect(alphas.some((alpha) => alpha > 0 && alpha < 255)).toBe(true);
  });
  it.each([32, 64])("uses identical %ipx listing and packaged artwork", (size) => {
    expect(
      readFileSync(new URL(`../store-assets/icons/icon-${size}.png`, import.meta.url)),
    ).toEqual(icon(size));
  });
});

describe("listing screenshot assets", () => {
  it.each([
    "01-active-profile",
    "02-profile-management",
    "03-identity-audit",
    "04-local-location-picker",
  ])("keeps %s at upload dimensions with matching provenance hash", (name) => {
    const png = readFileSync(new URL(`../store-assets/screenshots/${name}.png`, import.meta.url));
    expect(png.readUInt32BE(16)).toBe(1280);
    expect(png.readUInt32BE(20)).toBe(800);
    const metadata = readFileSync(
      new URL("../store-assets/screenshots/metadata.json", import.meta.url),
      "utf8",
    );
    expect(metadata).toContain(createHash("sha256").update(png).digest("hex"));
  });
});
