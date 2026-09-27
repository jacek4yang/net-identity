import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { payloadHashes, readZip, verifySignedPayload } from "../src/release/xpi";
import { EXTENSION_ID } from "../src/release/version";

/** Independent fixture writer uses Node's CRC implementation. */
function zip(entries: [string, string][], compressed = false): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text);
    const raw = compressed ? deflateRawSync(data) : data;
    const filename = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(compressed ? 8 : 0, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(raw.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 6);
    header.copy(directory, 8, 6, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, filename, raw);
    central.push(directory, filename);
    offset += header.length + filename.length + raw.length;
  }
  const table = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(table.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, table, end]);
}

const manifest = JSON.stringify({
  version: "1.1.0",
  browser_specific_settings: { gecko: { id: EXTENSION_ID } },
});
const payload: [string, string][] = [
  ["manifest.json", manifest],
  ["background.js", "// fixture"],
];
const signatures: [string, string][] = [
  ["META-INF/mozilla.rsa", "structural fixture only"],
  ["META-INF/mozilla.sf", "fixture"],
  ["META-INF/manifest.mf", "fixture"],
];

describe("signed XPI archive validation", () => {
  it.each([false, true])("reads bounded ZIP entries (deflate=%s)", (compressed) => {
    expect(readZip(zip(payload, compressed)).get("manifest.json")?.toString()).toBe(manifest);
  });
  it("rejects non-ZIP and CRC corruption", () => {
    expect(() => readZip(Buffer.from("not zip"))).toThrow();
    const bytes = zip(payload);
    bytes[30 + "manifest.json".length] = 0;
    expect(() => readZip(bytes)).toThrow(/CRC/);
  });
  it("rejects duplicate/traversal paths and malformed directory bounds", () => {
    expect(() => readZip(zip([...payload, payload[0] ?? ["", ""]]))).toThrow(/duplicate/);
    expect(() => readZip(zip([["../manifest.json", manifest]]))).toThrow(/path/);
    const bytes = zip(payload);
    bytes.writeUInt32LE(1, bytes.length - 6);
    expect(() => readZip(bytes)).toThrow(/bounds/);
  });
  it("rejects wrong version and ID", () => {
    expect(() => payloadHashes(zip(payload), "2.0.0")).toThrow(/version/);
    expect(() =>
      payloadHashes(zip([["manifest.json", manifest.replace(EXTENSION_ID, "wrong")]]), "1.1.0"),
    ).toThrow(/ID/);
  });
  it("allows only signing additions, never modified or added executable payload", () => {
    const expected = payloadHashes(zip(payload), "1.1.0");
    expect(() =>
      verifySignedPayload(zip([...payload, ...signatures]), "1.1.0", expected),
    ).not.toThrow();
    expect(() => verifySignedPayload(zip(payload), "1.1.0", expected)).toThrow(/Unsigned/);
    expect(() =>
      verifySignedPayload(zip([...payload, ...signatures, ["extra.js", "bad"]]), "1.1.0", expected),
    ).toThrow(/differs/);
    expect(() =>
      verifySignedPayload(
        zip([["manifest.json", manifest], ["background.js", "changed"], ...signatures]),
        "1.1.0",
        expected,
      ),
    ).toThrow(/differs/);
  });
});
