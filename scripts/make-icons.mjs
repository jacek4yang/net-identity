/**
 * Generates the extension icons.
 *
 * The icons are committed to the repository; this script exists so they can be
 * regenerated deterministically instead of being an opaque binary someone is
 * afraid to touch. Run with `npm run icons`.
 *
 * Output is byte-for-byte stable (no timestamps, no palette randomness).
 */
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "public", "icons");
const SIZES = [48, 96, 128];

/* --------------------------------------------------------------- PNG encoder */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type "none"
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------- drawing */

const BACKGROUND = [16, 43, 82]; // deep blue
const FOREGROUND = [235, 244, 255]; // near white
const ACCENT = [90, 200, 250]; // cyan

function mix(base, overlay, alpha) {
  return [
    Math.round(base[0] + (overlay[0] - base[0]) * alpha),
    Math.round(base[1] + (overlay[1] - base[1]) * alpha),
    Math.round(base[2] + (overlay[2] - base[2]) * alpha),
  ];
}

/**
 * Draws a rounded square with a globe: a circle plus horizontal and vertical
 * meridians, representing "network identity".
 */
function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const radius = size * 0.42;
  const corner = size * 0.22;
  const ringWidth = Math.max(1, size * 0.055);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distanceFromCenter = Math.hypot(x - center, y - center);
      const inCircle = distanceFromCenter <= radius;
      const ringOuter = radius - ringWidth <= distanceFromCenter && distanceFromCenter <= radius;

      // Vertical meridian: narrow ellipse across the circle.
      const nx = (x - center) / radius;
      const ny = (y - center) / radius;
      const verticalMeridian = inCircle && Math.abs(nx) <= 0.07;
      const horizontalMeridian = inCircle && Math.abs(ny) <= 0.07;
      const midMeridian = inCircle && Math.abs((nx * nx) / 0.28 + ny * ny - 1) <= 0.12;

      let color = BACKGROUND;
      let alpha = 255;

      // Rounded square background with transparent corners.
      const dx = Math.max(Math.abs(x - center) - (center - corner), 0);
      const dy = Math.max(Math.abs(y - center) - (center - corner), 0);
      const outsideRoundedSquare = Math.hypot(dx, dy) > corner;
      if (outsideRoundedSquare) {
        alpha = 0;
      } else if (ringOuter || verticalMeridian || horizontalMeridian || midMeridian) {
        color = mix(BACKGROUND, FOREGROUND, 0.95);
      } else if (inCircle) {
        color = mix(BACKGROUND, ACCENT, 0.22);
      }

      const offset = (y * size + x) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = alpha;
    }
  }

  return encodePng(size, size, pixels);
}

await mkdir(outputDir, { recursive: true });
for (const size of SIZES) {
  const file = path.join(outputDir, `icon-${size}.png`);
  await writeFile(file, renderIcon(size));
  console.error(`wrote ${path.relative(root, file)}`);
}
