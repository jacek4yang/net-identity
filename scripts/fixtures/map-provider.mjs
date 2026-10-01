/** Deterministic OpenFreeMap HTTPS fixture. No upstream connection is ever opened. */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

export const PROVIDER = "https://tiles.openfreemap.org";
export const GLYPH_PATH = "/fonts/Fixture%20Sans/25856-26111.pbf";
export const FIXTURE_STYLE = {
  version: 8,
  name: "Deterministic geography fixture",
  sprite: `${PROVIDER}/sprites/ofm_f384/ofm`,
  glyphs: `${PROVIDER}/fonts/{fontstack}/{range}.pbf`,
  sources: {
    relief: {
      type: "raster",
      tiles: [`${PROVIDER}/natural_earth/ne2sr/{z}/{x}/{y}.png`],
      minzoom: 0,
      maxzoom: 6,
      tileSize: 512,
    },
    openmaptiles: {
      type: "vector",
      tiles: [`${PROVIDER}/planet/20260930_001001_pt/0/0/0.pbf`],
      minzoom: 0,
      maxzoom: 0,
    },
  },
  layers: [
    { id: "ocean", type: "background", paint: { "background-color": "#2266dd" } },
    {
      id: "relief",
      type: "raster",
      source: "relief",
      paint: { "raster-opacity": 0.01, "raster-fade-duration": 0 },
    },
    {
      id: "land",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "land",
      paint: { "fill-color": "#55bb66" },
    },
    {
      id: "water",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "water",
      paint: { "fill-color": "#2266dd" },
    },
    {
      id: "road",
      type: "line",
      source: "openmaptiles",
      "source-layer": "road",
      paint: { "line-color": "#ff3355", "line-width": 9 },
    },
    {
      id: "city",
      type: "circle",
      source: "openmaptiles",
      "source-layer": "city",
      paint: { "circle-color": "#ffee22", "circle-radius": 13 },
    },
    {
      id: "city-icon",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "city",
      layout: { "icon-image": "city", "icon-allow-overlap": true },
    },
    {
      id: "cjk-label",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "label",
      layout: {
        "text-field": "日",
        "text-font": ["Fixture Sans"],
        "text-size": 72,
        "text-allow-overlap": true,
      },
      paint: { "text-color": "#cc22ee" },
    },
  ],
};

function uint(value) {
  const out = [];
  do {
    let byte = value & 127;
    value >>>= 7;
    if (value) byte |= 128;
    out.push(byte);
  } while (value);
  return Buffer.from(out);
}
const field = (id, value) => Buffer.concat([uint(id * 8), uint(value)]);
const bytes = (id, value) => {
  const b = Buffer.from(value);
  return Buffer.concat([uint(id * 8 + 2), uint(b.length), b]);
};
const zigzag = (value) => (value < 0 ? -value * 2 - 1 : value * 2);
function feature(type, coordinates, closed = false) {
  let x = 0,
    y = 0;
  const geometry = [];
  for (let i = 0; i < coordinates.length; i++) {
    const [nx, ny] = coordinates[i];
    if (i === 0) geometry.push(9);
    else if (i === 1) geometry.push(((coordinates.length - 1) << 3) | 2);
    geometry.push(zigzag(nx - x), zigzag(ny - y));
    x = nx;
    y = ny;
  }
  if (closed) geometry.push(15);
  return Buffer.concat([field(1, 1), field(3, type), bytes(4, Buffer.concat(geometry.map(uint)))]);
}
const layer = (name, item) =>
  bytes(3, Buffer.concat([bytes(1, name), bytes(2, item), field(5, 4096), field(15, 2)]));
export const VECTOR_TILE = Buffer.concat([
  layer(
    "land",
    feature(
      3,
      [
        [700, 700],
        [3400, 850],
        [3600, 1900],
        [2850, 3400],
        [1000, 3200],
        [450, 1800],
      ],
      true,
    ),
  ),
  // Keep an actual vector-water polygon inside the initial center/zoom. The
  // first CI capture was 660×280: the exterior coast only exposed 612 background
  // pixels at its corners, although all vector geometry rendered correctly.
  // This inland polygon projects wholly inside that unchanged view, so the
  // existing >1000 water-pixel assertion now verifies vector decoding too.
  layer(
    "water",
    feature(
      3,
      [
        [1400, 1900],
        [1850, 1750],
        [2050, 1950],
        [1900, 2300],
        [1450, 2250],
      ],
      true,
    ),
  ),
  layer(
    "road",
    feature(2, [
      [300, 2400],
      [1400, 1600],
      [2300, 2400],
      [3800, 1300],
    ]),
  ),
  layer("city", feature(1, [[2300, 2400]])),
  layer("label", feature(1, [[2800, 1900]])),
]);

// Original synthetic 日 glyph: five rectangular strokes, not copied font data.
// The official MapLibre parse_glyph_pbf.ts schema expects a 3px bitmap border;
// TinySDF encodes distance with radius=8, cutoff=.25. We evaluate the distance
// directly for these five rectangles, so no OS font, canvas, or new dependency
// is involved in generating the provider PBF. The two holes distinguish a real
// glyph from a missing-font/tofu rectangle in the Firefox screenshot assertion.
const glyphStrokes = [
  [0, 0, 3, 22],
  [15, 0, 18, 22],
  [0, 0, 18, 3],
  [0, 9, 18, 12],
  [0, 19, 18, 22],
];
export const GLYPH_BITMAP = Buffer.from(
  Array.from({ length: 24 * 28 }, (_, i) => {
    const x = (i % 24) - 3 + 0.5,
      y = Math.floor(i / 24) - 3 + 0.5;
    const distance = Math.min(
      ...glyphStrokes.map(([left, top, right, bottom]) => {
        const dx = Math.max(left - x, 0, x - right),
          dy = Math.max(top - y, 0, y - bottom);
        return dx || dy ? Math.hypot(dx, dy) : -Math.min(x - left, right - x, y - top, bottom - y);
      }),
    );
    return Math.max(0, Math.min(255, Math.round(255 * (0.75 - distance / 8))));
  }),
);
export const GLYPH_PBF = bytes(
  1,
  Buffer.concat([
    bytes(1, "Fixture Sans"),
    bytes(2, "25856-26111"),
    bytes(
      3,
      Buffer.concat([
        field(1, 0x65e5),
        bytes(2, GLYPH_BITMAP),
        field(3, 18),
        field(4, 22),
        field(5, zigzag(3)),
        field(6, zigzag(21)),
        field(7, 24),
      ]),
    ),
  ]),
);

/** Private, child-only Linux font configuration: explicitly no CJK font coverage. */
export async function isolateLatinFonts(directory) {
  if (process.platform !== "linux") throw new Error("--no-local-cjk requires Linux fontconfig");
  // Firefox's content font sandbox can read installed system fonts but not an
  // arbitrary copied TTF inside our profile root. This directory contains only
  // the distro's Latin DejaVu faces; no default/CJK directories are included.
  const fonts = "/usr/share/fonts/truetype/dejavu",
    cache = path.join(directory, "font-cache"),
    config = path.join(directory, "fonts.conf");
  await mkdir(cache);
  const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  await writeFile(
    config,
    `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><dir>${escape(fonts)}</dir><cachedir>${escape(cache)}</cachedir></fontconfig>`,
  );
  const env = { FONTCONFIG_FILE: config, FONTCONFIG_PATH: directory };
  const list = (charset) =>
    execFileSync("fc-list", [`:charset=${charset}`, "-f", "%{file}\\n"], {
      env: { ...process.env, ...env },
      encoding: "utf8",
    }).trim();
  if (!list("0041") || list("65e5"))
    throw new Error("Isolated fontconfig must have Latin A and no CJK U+65E5 coverage");
  return { env, evidence: { isolated: true, latinCoverage: true, cjkCoverage: false } };
}

/** Quantify the custom magenta glyph's actual ink and two holes, not tofu. */
export function inspectGlyphPixels({ width, height, channels, pixels }) {
  const ink = (x, y) =>
    [204, 34, 238].every((v, c) => Math.abs(pixels[(y * width + x) * channels + c] - v) <= 8);
  let count = 0,
    left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (ink(x, y)) {
        count++;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  const w = right - left + 1,
    h = bottom - top + 1;
  const patch = (rx, ry) => {
    if (!count) return 0;
    let hits = 0;
    const x = Math.round(left + (w - 1) * rx),
      y = Math.round(top + (h - 1) * ry);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if (ink(x + dx, y + dy)) hits++;
    return hits / 9;
  };
  const strokes = [
    patch(0.07, 0.26),
    patch(0.93, 0.7),
    patch(0.5, 0.05),
    patch(0.5, 0.48),
    patch(0.5, 0.95),
  ];
  const holes = [patch(0.5, 0.26), patch(0.5, 0.7)];
  return {
    count,
    bounds: { left, top, width: w, height: h },
    strokes,
    holes,
    rendered:
      count > 600 &&
      w > 35 &&
      w < 75 &&
      h > 45 &&
      h < 90 &&
      strokes.every((v) => v > 0.8) &&
      holes.every((v) => v === 0),
  };
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
export function png(width, height, pixel = [255, 238, 34, 255]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 4; c++) rows[y * (1 + width * 4) + 1 + x * 4 + c] = pixel[c];
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Decode Firefox screenshots for actual pixel assertions without a new dependency. */
export function readPng(data) {
  let width = 0,
    height = 0,
    channels = 0;
  const chunks = [];
  for (let offset = 8; offset < data.length;) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || ![2, 6].includes(body[9]) || body[12] !== 0)
        throw new Error("Unsupported screenshot PNG format");
      channels = body[9] === 6 ? 4 : 3;
    }
    if (type === "IDAT") chunks.push(body);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const aa = Math.abs(p - a),
      bb = Math.abs(p - b),
      cc = Math.abs(p - c);
    return aa <= bb && aa <= cc ? a : bb <= cc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x,
        left = x >= channels ? pixels[i - channels] : 0,
        up = y > 0 ? pixels[i - stride] : 0,
        corner = y > 0 && x >= channels ? pixels[i - stride - channels] : 0;
      const predictors = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, corner)];
      if (filter > 4) throw new Error("Unsupported PNG filter");
      pixels[i] = (raw[y * (stride + 1) + 1 + x] + predictors[filter]) & 255;
    }
  }
  return { width, height, channels, pixels };
}

export async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

export async function createMapFixture(directory) {
  const key = path.join(directory, "map-fixture-key.pem"),
    cert = path.join(directory, "map-fixture-cert.pem");
  const caKey = path.join(directory, "map-fixture-ca-key.pem");
  const ca = path.join(directory, "map-fixture-ca.pem");
  const csr = path.join(directory, "map-fixture.csr");
  const extensions = path.join(directory, "map-fixture.ext");
  const openssl = (args) => execFileSync("openssl", args, { stdio: "ignore" });
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    ca,
    "-days",
    "1",
    "-subj",
    "/CN=Net Identity Disposable Map Fixture CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    csr,
    "-subj",
    "/CN=tiles.openfreemap.org",
  ]);
  await writeFile(
    extensions,
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:tiles.openfreemap.org\n",
  );
  openssl([
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    ca,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    cert,
    "-days",
    "1",
    "-extfile",
    extensions,
  ]);
  const requests = [],
    connects = [],
    direct = [],
    sockets = new Set(),
    held = new Set();
  let hold = false;
  let failRaster = false;
  let requireAuth = false;
  const expectedAuth = `Basic ${Buffer.from("fixture-user:fixture-password").toString("base64")}`;
  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const servers = [];
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  };
  try {
    const secure = https.createServer(
      { key: await readFile(key), cert: await readFile(cert) },
      (request, response) => {
        const entry = { path: request.url, headers: request.headers, closed: false };
        requests.push(entry);
        response.on("close", () => {
          entry.closed = true;
          held.delete(response);
        });
        if (hold) {
          held.add(response);
          return;
        }
        if (failRaster && request.url.startsWith("/natural_earth/")) {
          entry.status = 503;
          response.writeHead(503, {
            "content-type": "text/plain",
            "cache-control": "no-store",
            connection: "close",
          });
          response.end("deterministic late raster failure");
          return;
        }
        let body, type;
        if (request.url === "/tls-bootstrap") {
          body = '<!doctype html><link rel="icon" href="data:,"><title>Local TLS fixture</title>';
          type = "text/html";
        } else if (request.url.startsWith("/styles/")) {
          body = JSON.stringify(FIXTURE_STYLE);
          type = "application/json";
        } else if (request.url === GLYPH_PATH) {
          body = GLYPH_PBF;
          type = "application/x-protobuf";
        } else if (request.url.endsWith(".pbf")) {
          body = VECTOR_TILE;
          type = "application/x-protobuf";
        } else if (request.url.endsWith(".json")) {
          body = JSON.stringify({ city: { width: 16, height: 16, x: 0, y: 0, pixelRatio: 1 } });
          type = "application/json";
        } else if (request.url.endsWith(".png")) {
          body = png(16, 16);
          type = "image/png";
        } else {
          body = "fixture";
          type = "text/plain";
        }
        response.writeHead(200, {
          "content-type": type,
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
          "set-cookie": "map_fixture_cookie=must-not-return; Secure; SameSite=None",
          connection: "close",
        });
        response.end(body);
      },
    );
    servers.push(secure);
    secure.on("connection", track);
    const securePort = await listen(secure);
    const proxy = http.createServer((_request, response) => {
      response.writeHead(502);
      response.end();
    });
    servers.push(proxy);
    proxy.on("connection", track);
    proxy.on("connect", (request, client, head) => {
      connects.push({
        target: request.url,
        authenticated: request.headers["proxy-authorization"] === expectedAuth,
      });
      if (request.url !== "tiles.openfreemap.org:443") {
        client.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
        return;
      }
      if (requireAuth && request.headers["proxy-authorization"] !== expectedAuth) {
        client.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm="map-fixture"\r\ncontent-length: 0\r\n\r\n',
        );
        return;
      }
      const upstream = net.connect(securePort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      track(upstream);
      const destroy = () => {
        upstream.destroy();
        client.destroy();
      };
      upstream.on("error", destroy);
      client.on("error", destroy);
    });
    const proxyPort = await listen(proxy);
    const sentinel = http.createServer((request, response) => {
      direct.push(request.url);
      response.writeHead(502);
      response.end();
    });
    servers.push(sentinel);
    sentinel.on("connect", (request, socket) => {
      direct.push(request.url);
      socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
    });
    sentinel.on("connection", track);
    const sentinelPort = await listen(sentinel);
    return {
      requests,
      connects,
      direct,
      proxyPort,
      sentinelPort,
      requireAuthentication: () => {
        requireAuth = true;
        // The bootstrap used Firefox's temporary manual proxy. Close every
        // established tunnel before measuring the extension-authenticated route.
        for (const socket of sockets) socket.destroy();
      },
      setFailRaster: (value) => {
        failRaster = value;
      },
      setHold: (value) => {
        hold = value;
      },
      held,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
