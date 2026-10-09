/** Versioned, authenticated vault format. Native WebCrypto only; no custom cipher. */
import { isPlainObject } from "../shared/result";

export const VAULT_VERSION = 1;
export const KDF_ITERATIONS = 600_000;
export const MAX_VAULT_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface VaultEnvelope {
  version: 1;
  controlled: boolean;
  id: string;
  salt: string;
  iterations: typeof KDF_ITERATIONS;
  iv: string;
  ciphertext: string;
}

export function encodeBytes(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

export function decodeBytes(text: string, min: number, max = min): Uint8Array<ArrayBuffer> {
  if (text.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text))
    throw new Error("Invalid vault encoding.");
  const decoded = atob(text);
  if (decoded.length < min || decoded.length > max) throw new Error("Invalid vault size.");
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (encodeBytes(bytes) !== text) throw new Error("Non-canonical vault encoding.");
  return bytes;
}

export function parseVaultEnvelope(value: unknown): VaultEnvelope {
  if (
    !isPlainObject(value) ||
    value.version !== VAULT_VERSION ||
    typeof value.controlled !== "boolean" ||
    value.iterations !== KDF_ITERATIONS ||
    typeof value.id !== "string" ||
    typeof value.salt !== "string" ||
    typeof value.iv !== "string" ||
    typeof value.ciphertext !== "string" ||
    Object.keys(value).sort().join(",") !== "ciphertext,controlled,id,iterations,iv,salt,version"
  )
    throw new Error("Unsupported or damaged vault. Stored data was preserved.");
  decodeBytes(value.id, 16);
  decodeBytes(value.salt, 16);
  decodeBytes(value.iv, 12);
  decodeBytes(value.ciphertext, 16, MAX_VAULT_BYTES + 16);
  return {
    version: 1,
    controlled: value.controlled,
    id: value.id,
    salt: value.salt,
    iterations: KDF_ITERATIONS,
    iv: value.iv,
    ciphertext: value.ciphertext,
  };
}

export function newVaultHeader(): Pick<
  VaultEnvelope,
  "version" | "controlled" | "id" | "salt" | "iterations"
> {
  return {
    version: 1,
    controlled: false,
    id: encodeBytes(crypto.getRandomValues(new Uint8Array(16))),
    salt: encodeBytes(crypto.getRandomValues(new Uint8Array(16))),
    iterations: KDF_ITERATIONS,
  };
}

export async function deriveVaultKey(
  password: string,
  salt: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = encoder.encode(password);
  if ([...password].length < 12 || bytes.length > 1024)
    throw new Error(
      "Use a master password of at least 12 characters and at most 1024 UTF-8 bytes.",
    );
  try {
    const material = await crypto.subtle.importKey("raw", bytes, "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          salt: decodeBytes(salt, 16),
          iterations: KDF_ITERATIONS,
          hash: "SHA-256",
        },
        material,
        256,
      ),
    );
  } finally {
    bytes.fill(0);
  }
}

function aad(
  header: Pick<VaultEnvelope, "version" | "controlled" | "id" | "salt" | "iterations">,
): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    JSON.stringify([
      "net-identity/vault",
      header.version,
      header.controlled,
      header.id,
      header.salt,
      header.iterations,
    ]),
  );
}

export async function sealVault(
  data: unknown,
  rawKey: Uint8Array<ArrayBuffer>,
  header: Pick<VaultEnvelope, "version" | "controlled" | "id" | "salt" | "iterations">,
): Promise<VaultEnvelope> {
  const plaintext = encoder.encode(JSON.stringify(data));
  if (plaintext.byteLength > MAX_VAULT_BYTES) throw new Error("Vault storage limit exceeded.");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(header), tagLength: 128 },
      key,
      plaintext,
    );
    return {
      version: 1,
      controlled: header.controlled,
      id: header.id,
      salt: header.salt,
      iterations: KDF_ITERATIONS,
      iv: encodeBytes(iv),
      ciphertext: encodeBytes(new Uint8Array(ciphertext)),
    };
  } finally {
    plaintext.fill(0);
  }
}

export async function openVault(
  envelope: VaultEnvelope,
  rawKey: Uint8Array<ArrayBuffer>,
): Promise<unknown> {
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  let plaintext: Uint8Array<ArrayBuffer>;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decodeBytes(envelope.iv, 12),
          additionalData: aad(envelope),
          tagLength: 128,
        },
        key,
        decodeBytes(envelope.ciphertext, 16, MAX_VAULT_BYTES + 16),
      ),
    );
  } catch {
    throw new Error(
      "Unable to unlock: incorrect password or damaged backup. Stored data was preserved.",
    );
  }
  try {
    const value: unknown = JSON.parse(decoder.decode(plaintext));
    return value;
  } finally {
    plaintext.fill(0);
  }
}
