import assert from "node:assert/strict";
import { test } from "node:test";
import { PbfReader } from "pbf";
import {
  FIXTURE_STYLE,
  GLYPH_BITMAP,
  GLYPH_PATH,
  GLYPH_PBF,
  inspectGlyphPixels,
} from "./map-provider.mjs";

test("original glyph PBF has matching range, dimensions, metrics and SDF data", () => {
  const glyphs = [];
  new PbfReader(GLYPH_PBF).readFields((tag, _, reader) => {
    if (tag === 1)
      reader.readMessage((tag, _, reader) => {
        if (tag === 3)
          glyphs.push(
            reader.readMessage((tag, out, reader) => {
              out[tag] =
                tag === 2
                  ? reader.readBytes()
                  : tag === 5 || tag === 6
                    ? reader.readSVarint()
                    : reader.readVarint();
            }, {}),
          );
      }, null);
  }, null);
  assert.equal(glyphs.length, 1);
  const glyph = glyphs[0];
  assert.equal(glyph[1], "日".codePointAt(0));
  assert.deepEqual([glyph[3], glyph[4], glyph[5], glyph[6], glyph[7]], [18, 22, 3, 21, 24]);
  assert.equal(glyph[2].length, (glyph[3] + 6) * (glyph[4] + 6));
  assert.deepEqual(Buffer.from(glyph[2]), GLYPH_BITMAP);
  assert.ok(GLYPH_PATH.endsWith("/25856-26111.pbf"));
  assert.ok(glyph[1] >= 25856 && glyph[1] <= 26111);
  assert.ok(FIXTURE_STYLE.glyphs.endsWith("/fonts/{fontstack}/{range}.pbf"));
});

function image(shape) {
  const width = 120,
    height = 120,
    channels = 3,
    pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < 28 * 3; y++)
    for (let x = 0; x < 24 * 3; x++) {
      const gx = Math.floor(x / 3),
        gy = Math.floor(y / 3);
      if (shape(gx - 3, gy - 3, GLYPH_BITMAP[gy * 24 + gx] > 191)) {
        const offset = ((y + 16) * width + x + 16) * channels;
        pixels.set([204, 34, 238], offset);
      }
    }
  return { width, height, channels, pixels };
}

test("pixel oracle recognizes the provider's two-hole CJK glyph", () => {
  const result = inspectGlyphPixels(image((_x, _y, sdfInk) => sdfInk));
  assert.equal(result.rendered, true);
  assert.ok(result.count > 600);
  assert.deepEqual(result.holes, [0, 0]);
  assert.deepEqual(result.strokes, [1, 1, 1, 1, 1]);
});

test("pixel oracle rejects blank, solid, and missing-glyph tofu renders", () => {
  const outside = (x, y) => x < 0 || x >= 18 || y < 0 || y >= 22;
  for (const shape of [
    () => false,
    (x, y) => !outside(x, y),
    (x, y) => !outside(x, y) && (x < 3 || x >= 15 || y < 3 || y >= 19),
  ])
    assert.equal(inspectGlyphPixels(image(shape)).rendered, false);
});
