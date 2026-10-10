import { describe, expect, it } from "vitest";
import {
  deriveVaultKey,
  newVaultHeader,
  openVault,
  parseVaultEnvelope,
  sealVault,
} from "../src/vault/crypto";

describe("authenticated persistent vault", () => {
  it("round trips Unicode without storing a password or plaintext", async () => {
    const header = newVaultHeader();
    const key = await deriveVaultKey("我的保险库-strong-passphrase", header.salt);
    const data = { host: "private.example", password: "秘密-password", saved: [1, 2] };
    const sealed = await sealVault(data, key, header);
    expect(await openVault(parseVaultEnvelope(sealed), key)).toEqual(data);
    expect(JSON.stringify(sealed)).not.toContain("private.example");
    expect(JSON.stringify(sealed)).not.toContain("秘密-password");
    const second = await sealVault(data, key, header);
    expect(second.iv).not.toBe(sealed.iv);
    expect(second.ciphertext).not.toBe(sealed.ciphertext);
    key.fill(0);
  });
  it("rejects wrong passwords and all authenticated field modifications", async () => {
    const header = newVaultHeader();
    const key = await deriveVaultKey("correct horse battery staple", header.salt);
    const wrong = await deriveVaultKey("another horse battery staple", header.salt);
    const sealed = await sealVault({ data: "keep me" }, key, header);
    await expect(openVault(sealed, wrong)).rejects.toThrow("Unable to unlock");
    await expect(openVault({ ...sealed, controlled: !sealed.controlled }, key)).rejects.toThrow();
    for (const field of ["id", "salt", "iv", "ciphertext"] as const) {
      const altered = {
        ...sealed,
        [field]: (sealed[field][0] === "A" ? "B" : "A") + sealed[field].slice(1),
      };
      await expect(openVault(parseVaultEnvelope(altered), key)).rejects.toThrow();
    }
  });
  it("refuses future, malformed and unreasonable KDF formats without interpreting them", () => {
    const header = newVaultHeader();
    for (const value of [
      null,
      {},
      { ...header, version: 2 },
      { ...header, iterations: 1 },
      { ...header, iterations: 2 ** 32 },
    ])
      expect(() => parseVaultEnvelope(value)).toThrow();
  });
  it("refuses empty and unbounded passwords", async () => {
    const { salt } = newVaultHeader();
    await expect(deriveVaultKey("", salt)).rejects.toThrow();
    await expect(deriveVaultKey("x".repeat(1025), salt)).rejects.toThrow();
  });
});
