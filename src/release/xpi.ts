import { inflateRawSync } from "node:zlib";
import { record } from "./amo-api.ts";
import { sha256 } from "./download.ts";
import { EXTENSION_ID } from "./version.ts";

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Bounded, single-disk ZIP reader. Rejects ZIP64, encryption and ambiguous names. */
export function readZip(bytes: Buffer): Map<string, Buffer> {
  if (bytes.length < 22 || bytes.length > 25_000_000) throw new Error("Invalid ZIP size");
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0 || bytes.readUInt32LE(end + 4) !== 0) throw new Error("Invalid ZIP end/disk");
  const count = bytes.readUInt16LE(end + 10);
  if (count === 0 || count > 2000 || count !== bytes.readUInt16LE(end + 8))
    throw new Error("Invalid ZIP entry count");
  let offset = bytes.readUInt32LE(end + 16);
  if (offset + bytes.readUInt32LE(end + 12) !== end)
    throw new Error("Invalid ZIP directory bounds");
  const result = new Map<string, Buffer>();
  const regions: [number, number][] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Invalid ZIP directory entry");
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const next =
      offset + 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      next > end ||
      local + 30 > bytes.readUInt32LE(end + 16) ||
      size > 10_000_000 ||
      bytes.readUInt16LE(offset + 34) !== 0
    )
      throw new Error("Unsupported ZIP entry");
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (
      !/^[\x20-\x7e]+$/.test(name) ||
      name.includes("\\") ||
      name.startsWith("/") ||
      name.includes(":") ||
      name.split("/").some((part) => part === ".." || part === ".") ||
      result.has(name)
    )
      throw new Error("Unsafe or duplicate ZIP path");
    if (
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt16LE(local + 6) !== flags
    )
      throw new Error("ZIP local header mismatch");
    const localNameLength = bytes.readUInt16LE(local + 26);
    const start = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    if (
      bytes.toString("utf8", local + 30, local + 30 + localNameLength) !== name ||
      start + compressed > bytes.readUInt32LE(end + 16)
    )
      throw new Error("ZIP entry bounds/name mismatch");
    if (regions.some(([a, b]) => local < b && start + compressed > a))
      throw new Error("Overlapping ZIP entries");
    regions.push([local, start + compressed]);
    total += size;
    if (total > 30_000_000) throw new Error("ZIP expansion limit exceeded");
    const raw = bytes.subarray(start, start + compressed);
    const content =
      method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
    if (content.length !== size || crc32(content) !== crc) throw new Error("ZIP size/CRC mismatch");
    result.set(name, content);
    offset = next;
  }
  if (offset !== end) throw new Error("Trailing ZIP directory data");
  return result;
}

export function payloadHashes(bytes: Buffer, version: string): Record<string, string> {
  const files = readZip(bytes);
  const manifestBytes = files.get("manifest.json");
  if (!manifestBytes) throw new Error("Missing XPI manifest");
  const manifest = record(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  const gecko = record(record(manifest.browser_specific_settings).gecko);
  if (manifest.version !== version || gecko.id !== EXTENSION_ID)
    throw new Error("XPI version/extension ID mismatch");
  if (gecko.update_url !== undefined) throw new Error("Listed XPI must use AMO automatic updates");
  return Object.fromEntries(
    [...files]
      .filter(([name]) => !name.startsWith("META-INF/") && !name.endsWith("/"))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, data]) => [name, sha256(data)]),
  );
}

export function verifySignedPayload(
  bytes: Buffer,
  version: string,
  expected: Record<string, string>,
): void {
  const files = readZip(bytes);
  const signatureNames = new Set([
    "META-INF/",
    "META-INF/mozilla.rsa",
    "META-INF/mozilla.sf",
    "META-INF/manifest.mf",
    "META-INF/cose.manifest",
    "META-INF/cose.sig",
  ]);
  if ([...files.keys()].some((name) => name.startsWith("META-INF/") && !signatureNames.has(name))) {
    throw new Error("Unexpected signing metadata file");
  }
  // Presence is only a structural check. Firefox validates the actual signature later.
  if (
    !files.has("META-INF/mozilla.rsa") ||
    !files.has("META-INF/mozilla.sf") ||
    !files.has("META-INF/manifest.mf")
  )
    throw new Error("Unsigned XPI: signature entries missing");
  const actual = payloadHashes(bytes, version);
  const names = Object.keys(actual);
  if (
    names.length !== Object.keys(expected).length ||
    names.some((name) => actual[name] !== expected[name])
  )
    throw new Error("Signed XPI differs from tested submission payload");
}
