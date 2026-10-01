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
const SIZES = [16, 32, 48, 64, 96, 128];

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

// A shield enclosing one continuous route and its two endpoints. Geometry is
// shared with the SVG master, so editing the master means editing these points.
const SHIELD = [
  [8, 3],
  [13.5, 5],
  [13.5, 9],
  [12, 12],
  [8, 15],
  [4, 12],
  [2.5, 9],
  [2.5, 5],
];
const ROUTE = [
  [5.5, 6.25],
  [5.5, 9.5],
  [10.5, 9.5],
  [10.5, 6.25],
];
const NAVY = [21, 47, 68];
const MINT = [105, 239, 200];
const WHITE = [247, 253, 255];

function polygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segmentDistance(x, y, a, b) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}
function sample(x, y) {
  if (!polygon(x, y, SHIELD)) return null;
  if (Math.hypot(x - 10.5, y - 6.25) <= 1.35) return MINT;
  if (Math.hypot(x - 5.5, y - 6.25) <= 1.35) return WHITE;
  if (ROUTE.slice(1).some((b, i) => segmentDistance(x, y, ROUTE[i], b) <= 0.75)) return WHITE;
  return NAVY;
}
function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0];
      let covered = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const color = sample(
            ((x + (sx + 0.5) / samples) * 16) / size,
            ((y + (sy + 0.5) / samples) * 16) / size,
          );
          if (color) {
            covered++;
            for (let c = 0; c < 3; c++) sum[c] += color[c];
          }
        }
      }
      const offset = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) pixels[offset + c] = covered ? Math.round(sum[c] / covered) : 0;
      pixels[offset + 3] = Math.round((255 * covered) / (samples * samples));
    }
  }
  return encodePng(size, size, pixels);
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none">
  <title>Net Identity route shield</title>
  <path fill="#152f44" d="M${SHIELD.map((p) => p.join(" ")).join("L")}Z"/>
  <path d="M${ROUTE.map((p) => p.join(" ")).join("L")}" stroke="#f7fdff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="5.5" cy="6.25" r="1.35" fill="#f7fdff"/>
  <circle cx="10.5" cy="6.25" r="1.35" fill="#69efc8"/>
</svg>
`;
await mkdir(outputDir, { recursive: true });
const listingDir = path.join(root, "store-assets", "icons");
await mkdir(listingDir, { recursive: true });
await writeFile(path.join(listingDir, "icon.svg"), svg);
for (const size of SIZES) {
  const png = renderIcon(size);
  const file = path.join(outputDir, `icon-${size}.png`);
  await writeFile(file, png);
  if (size === 32 || size === 64) await writeFile(path.join(listingDir, `icon-${size}.png`), png);
  console.error(`wrote ${path.relative(root, file)}`);
}
