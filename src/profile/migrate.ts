/**
 * Forward migrations for the durable profile document (`ni.state.v1`).
 *
 * Version 1 is the only shape this project has stored. A later release adds a
 * step here and bumps `SCHEMA_VERSION`. It does not reuse version 1 for a new
 * field. Session snapshots and proxy passwords are not part of this document:
 * a password key found in it is dropped and never written back.
 *
 * A newer schema is left byte-for-byte in storage. A version we do understand
 * but cannot parse without discarding a profile or its proxy is also left
 * untouched, so a missing host cannot become a direct connection.
 */
import { MAX_PROFILES } from "../shared/constants";
import { isPlainObject } from "../shared/result";
import {
  EMPTY_PROFILE_STATE,
  SCHEMA_VERSION,
  type IdentityProfile,
  type ProfileState,
} from "./schema";
import { parseProfile } from "./validation";

export type MigrationHoldReason = "future-schema" | "unsafe-profile";

export type MigrationResult =
  | { status: "ready"; state: ProfileState; persist: boolean }
  | { status: "hold"; reason: MigrationHoldReason; schemaVersion: number | null };

const SECRET_KEYS = new Set(["password", "credentials", "proxyPassword"]);

export function migrationHoldMessage(result: Extract<MigrationResult, { status: "hold" }>): string {
  if (result.reason === "future-schema") {
    return `Stored profiles use schema version ${String(result.schemaVersion)}, which this version of net-identity does not understand. They were left unchanged.`;
  }
  return "Stored profiles could not be migrated without dropping a profile or its proxy. They were left unchanged.";
}

export function migrateStoredProfileState(raw: unknown): MigrationResult {
  if (raw === undefined)
    return { status: "ready", state: structuredClone(EMPTY_PROFILE_STATE), persist: false };
  if (!isPlainObject(raw)) {
    return { status: "ready", state: structuredClone(EMPTY_PROFILE_STATE), persist: false };
  }

  const version = raw.schemaVersion;
  if (version === undefined || version === 0 || version === 1) return migrateVersion1(raw);
  if (typeof version === "number" && Number.isInteger(version) && version > SCHEMA_VERSION) {
    return { status: "hold", reason: "future-schema", schemaVersion: version };
  }
  return { status: "hold", reason: "unsafe-profile", schemaVersion: null };
}

function migrateVersion1(raw: Record<string, unknown>): MigrationResult {
  if (!Array.isArray(raw.profiles)) {
    return { status: "hold", reason: "unsafe-profile", schemaVersion: 1 };
  }
  if (raw.profiles.length > MAX_PROFILES) {
    return { status: "hold", reason: "unsafe-profile", schemaVersion: 1 };
  }

  const profiles: IdentityProfile[] = [];
  const seen = new Set<string>();
  for (const entry of raw.profiles) {
    if (!isPlainObject(entry))
      return { status: "hold", reason: "unsafe-profile", schemaVersion: 1 };
    const parsed = parseProfile(stripSecrets(entry));
    if (!parsed.ok) return { status: "hold", reason: "unsafe-profile", schemaVersion: 1 };
    if (seen.has(parsed.value.id))
      return { status: "hold", reason: "unsafe-profile", schemaVersion: 1 };
    seen.add(parsed.value.id);
    profiles.push(parsed.value);
  }

  let activeProfileId: string | null;
  if (raw.activeProfileId === undefined || raw.activeProfileId === null) {
    activeProfileId = null;
  } else if (typeof raw.activeProfileId !== "string") {
    return { status: "hold", reason: "unsafe-profile", schemaVersion: 1 };
  } else {
    activeProfileId = seen.has(raw.activeProfileId) ? raw.activeProfileId : null;
  }

  const state: ProfileState = { schemaVersion: SCHEMA_VERSION, activeProfileId, profiles };
  return { status: "ready", state, persist: JSON.stringify(raw) !== JSON.stringify(state) };
}

function stripSecrets(value: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) continue;
    next[key] = stripSecretsDeep(child);
  }
  return next;
}

function stripSecretsDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stripSecretsDeep(entry));
  if (!isPlainObject(value)) return value;
  return stripSecrets(value);
}
