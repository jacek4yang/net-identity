/** Single-writer encrypted storage boundary. No network access; no durable key. */
import { ACTIVE_TARGET_KEY, CREDENTIAL_KEY_PREFIX, STORAGE_KEY } from "../shared/constants";
import { isPlainObject } from "../shared/result";
import { readKey, type StorageAreaLike } from "../shared/storage";
import { migrateStoredProfileState } from "../profile/migrate";
import { durableProfileState, EMPTY_PROFILE_STATE } from "../profile/schema";
import { isValidProfileId, parseCredentials } from "../profile/validation";
import { parseActiveTargetSnapshot } from "../background/active-target";
import {
  decodeBytes,
  deriveVaultKey,
  encodeBytes,
  newVaultHeader,
  openVault,
  parseVaultEnvelope,
  sealVault,
  type VaultEnvelope,
} from "./crypto";

export const VAULT_KEY = "ni.vault.v1";
export const VAULT_PREVIOUS_KEY = "ni.vault.previous.v1";
export const VAULT_SESSION_KEY = "ni.vault.session.v1";
// Older versions must hold this document rather than silently create empty profiles.
const ENCRYPTED_SENTINEL = { schemaVersion: 5, encryptedVault: true };
export type VaultStatus = "unencrypted" | "locked" | "unlocked" | "damaged";
class VaultLockedError extends Error {}

interface VaultData {
  version: 1;
  profiles: unknown;
  secrets: Record<string, unknown>;
}

function secretKey(key: string): boolean {
  return (
    key === ACTIVE_TARGET_KEY ||
    (key.startsWith(CREDENTIAL_KEY_PREFIX) &&
      isValidProfileId(key.slice(CREDENTIAL_KEY_PREFIX.length)))
  );
}

function parseData(value: unknown): VaultData {
  if (
    !isPlainObject(value) ||
    value.version !== 1 ||
    !isPlainObject(value.secrets) ||
    !Object.hasOwn(value, "profiles")
  )
    throw new Error("Unsupported vault contents. Stored data was preserved.");
  const migrated = migrateStoredProfileState(value.profiles);
  if (migrated.status !== "ready")
    throw new Error("Unsupported profile data. Stored data was preserved.");
  const secrets: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value.secrets)) {
    if (!secretKey(key)) throw new Error("Unsupported vault entry.");
    const parsed =
      key === ACTIVE_TARGET_KEY ? parseActiveTargetSnapshot(raw) : parseCredentials(raw);
    if (!parsed.ok) throw new Error("Invalid vault entry. Stored data was preserved.");
    secrets[key] = parsed.value;
  }
  return { version: 1, profiles: durableProfileState(migrated.state), secrets };
}

async function readData(envelope: VaultEnvelope, key: Uint8Array<ArrayBuffer>): Promise<VaultData> {
  const data = parseData(await openVault(envelope, key));
  const profiles = migrateStoredProfileState(data.profiles);
  if (
    profiles.status !== "ready" ||
    envelope.controlled !== (profiles.state.activeProfileId !== null)
  )
    throw new Error("Vault routing metadata does not match its contents.");
  return data;
}

export class VaultStore {
  private queue: Promise<unknown> = Promise.resolve();
  private key: Uint8Array<ArrayBuffer> | null = null;
  private keyId: string | null = null;
  readonly profiles: StorageAreaLike;
  readonly secrets: StorageAreaLike;

  constructor(
    private readonly local: StorageAreaLike,
    private readonly session: StorageAreaLike,
  ) {
    this.profiles = this.area(false);
    this.secrets = this.area(true);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async envelope(): Promise<VaultEnvelope | null> {
    const value = await readKey(this.local, VAULT_KEY);
    return value === undefined ? null : parseVaultEnvelope(value);
  }

  private async loadKey(envelope: VaultEnvelope): Promise<Uint8Array<ArrayBuffer>> {
    if (this.key && this.keyId === envelope.id) return this.key;
    const cached = await readKey(this.session, VAULT_SESSION_KEY);
    if (!isPlainObject(cached) || cached.id !== envelope.id || typeof cached.key !== "string")
      throw new VaultLockedError("Unlock your encrypted vault to use saved profiles.");
    const key = decodeBytes(cached.key, 32);
    // A session entry alone is not proof that it belongs to this ciphertext.
    try {
      await readData(envelope, key);
    } catch (error) {
      key.fill(0);
      throw error;
    }
    this.key?.fill(0);
    this.key = key;
    this.keyId = envelope.id;
    return key;
  }

  private async remember(key: Uint8Array<ArrayBuffer>, envelope: VaultEnvelope): Promise<void> {
    // storage.session is memory-only and inaccessible to content scripts by default.
    await this.session.set({ [VAULT_SESSION_KEY]: { id: envelope.id, key: encodeBytes(key) } });
    this.key?.fill(0);
    this.key = key.slice();
    this.keyId = envelope.id;
  }

  status(): Promise<VaultStatus> {
    return this.enqueue(async () => {
      let envelope: VaultEnvelope | null;
      try {
        envelope = await this.envelope();
      } catch {
        return "damaged";
      }
      if (!envelope) return "unencrypted";
      try {
        const key = await this.loadKey(envelope);
        await readData(envelope, key);
        return "unlocked";
      } catch {
        return "locked";
      }
    });
  }

  /** One explicit setup, preserving applied versus saved configuration independently. */
  setup(password: string): Promise<void> {
    return this.enqueue(async () => {
      if ((await readKey(this.local, VAULT_KEY)) !== undefined)
        throw new Error("A vault already exists.");
      const raw = await readKey(this.local, STORAGE_KEY);
      const migrated = migrateStoredProfileState(raw);
      if (migrated.status !== "ready")
        throw new Error("Existing profiles cannot be safely migrated. They were preserved.");
      const existing = await this.session.get(null);
      const data = parseData({
        version: 1,
        profiles: durableProfileState(migrated.state),
        secrets: Object.fromEntries(Object.entries(existing).filter(([key]) => secretKey(key))),
      });
      const header = { ...newVaultHeader(), controlled: migrated.state.activeProfileId !== null };
      const key = await deriveVaultKey(password, header.salt);
      try {
        const envelope = await sealVault(data, key, header);
        // Verify the encrypted representation before replacing the legacy document.
        await readData(envelope, key);
        await this.local.set({
          [VAULT_KEY]: envelope,
          [VAULT_PREVIOUS_KEY]: envelope,
          [STORAGE_KEY]: ENCRYPTED_SENTINEL,
        });
        const persisted = await this.envelope();
        if (!persisted || JSON.stringify(persisted) !== JSON.stringify(envelope))
          throw new Error("Vault write verification failed. Keep your backup.");
        await this.remember(key, envelope);
        await this.session.remove(Object.keys(data.secrets));
      } finally {
        key.fill(0);
      }
    });
  }

  unlock(password: string): Promise<void> {
    return this.enqueue(async () => {
      const envelope = await this.envelope();
      if (!envelope) throw new Error("No encrypted vault exists.");
      const key = await deriveVaultKey(password, envelope.salt);
      try {
        await readData(envelope, key);
        await this.remember(key, envelope);
      } finally {
        key.fill(0);
      }
    });
  }

  /** Ciphertext only. Export remains possible while locked, including the prior revision. */
  backup(previous = false): Promise<string> {
    return this.enqueue(async () => {
      const envelope = parseVaultEnvelope(
        await readKey(this.local, previous ? VAULT_PREVIOUS_KEY : VAULT_KEY),
      );
      return JSON.stringify(envelope, null, 2);
    });
  }

  /** Restore only into an empty installation; never overwrite an existing vault/profile. */
  restore(backup: unknown, password: string): Promise<void> {
    return this.enqueue(async () => {
      if ((await readKey(this.local, VAULT_KEY)) !== undefined)
        throw new Error("Restore requires an empty installation. Existing data was preserved.");
      const legacy = migrateStoredProfileState(await readKey(this.local, STORAGE_KEY));
      if (
        legacy.status !== "ready" ||
        durableProfileState(legacy.state).profiles.length !== 0 ||
        legacy.state.activeProfileId !== null
      )
        throw new Error(
          "Restore requires an empty installation. Existing profiles were preserved.",
        );
      const envelope = parseVaultEnvelope(backup);
      const key = await deriveVaultKey(password, envelope.salt);
      try {
        await readData(envelope, key);
        await this.local.set({
          [VAULT_KEY]: envelope,
          [VAULT_PREVIOUS_KEY]: envelope,
          [STORAGE_KEY]: ENCRYPTED_SENTINEL,
        });
        await this.remember(key, envelope);
      } finally {
        key.fill(0);
      }
    });
  }

  private area(secrets: boolean): StorageAreaLike {
    const source = secrets ? this.session : this.local;
    const allowed = (key: string) => (secrets ? secretKey(key) : key === STORAGE_KEY);
    const read = async (envelope: VaultEnvelope): Promise<Record<string, unknown>> => {
      const data = await readData(envelope, await this.loadKey(envelope));
      return secrets ? data.secrets : { [STORAGE_KEY]: data.profiles };
    };
    const mutate = (apply: (entries: Record<string, unknown>) => void): Promise<void> =>
      this.enqueue(async () => {
        const envelope = await this.envelope();
        if (!envelope) {
          const entries = Object.fromEntries(
            Object.entries(await source.get(null)).filter(([key]) => allowed(key)),
          );
          const oldKeys = Object.keys(entries);
          apply(entries);
          await source.set(entries);
          await source.remove(oldKeys.filter((key) => !Object.hasOwn(entries, key)));
          return;
        }
        const key = await this.loadKey(envelope);
        const data = await readData(envelope, key);
        const entries = secrets ? data.secrets : { [STORAGE_KEY]: data.profiles };
        apply(entries);
        const next = parseData({
          ...data,
          ...(secrets ? { secrets: entries } : { profiles: entries[STORAGE_KEY] }),
        });
        const migrated = migrateStoredProfileState(next.profiles);
        if (migrated.status !== "ready") throw new Error("Invalid vault profiles.");
        const sealed = await sealVault(next, key, {
          ...envelope,
          controlled: migrated.state.activeProfileId !== null,
        });
        // One storage operation commits both the new ciphertext and recoverable previous revision.
        await this.local.set({ [VAULT_KEY]: sealed, [VAULT_PREVIOUS_KEY]: envelope });
      });
    return {
      get: (keys) =>
        this.enqueue(async () => {
          const envelope = await this.envelope();
          let entries: Record<string, unknown>;
          if (!envelope) entries = await source.get(keys);
          else {
            try {
              entries = await read(envelope);
            } catch (error) {
              // A previously committed Off stays Off before unlock. Active routes
              // remain blocked; no profile/credential mutation is allowed locked.
              if (error instanceof VaultLockedError && !secrets && !envelope.controlled)
                entries = {
                  [STORAGE_KEY]: durableProfileState(structuredClone(EMPTY_PROFILE_STATE)),
                };
              else throw error;
            }
          }
          const selected =
            keys === null || keys === undefined
              ? Object.keys(entries)
              : typeof keys === "string"
                ? [keys]
                : keys;
          return Object.fromEntries(
            selected
              .filter((key) => allowed(key) && Object.hasOwn(entries, key))
              .map((key) => [key, structuredClone(entries[key])]),
          );
        }),
      set: (items) =>
        mutate((entries) => {
          for (const [key, value] of Object.entries(items)) {
            if (!allowed(key)) throw new Error("Unexpected vault storage key.");
            entries[key] = structuredClone(value);
          }
        }),
      remove: (keys) =>
        mutate((entries) => {
          for (const key of typeof keys === "string" ? [keys] : keys) {
            if (!allowed(key)) throw new Error("Unexpected vault storage key.");
            delete entries[key];
          }
        }),
      clear: () =>
        mutate((entries) => {
          for (const key of Object.keys(entries)) delete entries[key];
        }),
    };
  }
}
