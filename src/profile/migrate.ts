/**
 * Forward migrations for the durable profile document (`ni.state.v1`).
 *
 * Versions 1–3 migrate to schema 4, which retains only a non-secret authentication
 * marker instead of a username. Version 3 applied routes remain separate from saved edits. The durable
 * key is unchanged; built-in Direct is projected rather than persisted. Session snapshots and proxy credentials are not part of this document:
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
  ensureBuiltinDirect,
  durableProfileState,
  isBuiltinDirectProfile,
  type AppliedSelection,
  type IdentityProfile,
  type ProfileState,
} from "./schema";
import { parseAppliedSelection, parseProfile } from "./validation";

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
    return { status: "hold", reason: "unsafe-profile", schemaVersion: null };
  }

  const version = raw.schemaVersion;
  if (
    version === undefined ||
    version === 0 ||
    version === 1 ||
    version === 2 ||
    version === 3 ||
    version === SCHEMA_VERSION
  )
    return migrateSupportedDocument(raw);
  if (typeof version === "number" && Number.isInteger(version) && version > SCHEMA_VERSION) {
    return { status: "hold", reason: "future-schema", schemaVersion: version };
  }
  return { status: "hold", reason: "unsafe-profile", schemaVersion: null };
}

function migrateSupportedDocument(raw: Record<string, unknown>): MigrationResult {
  const version = typeof raw.schemaVersion === "number" ? raw.schemaVersion : 1;
  if (!Array.isArray(raw.profiles)) {
    return { status: "hold", reason: "unsafe-profile", schemaVersion: version };
  }
  if (raw.profiles.length > MAX_PROFILES) {
    return { status: "hold", reason: "unsafe-profile", schemaVersion: version };
  }

  const profiles: IdentityProfile[] = [];
  const seen = new Set<string>();
  for (const entry of raw.profiles) {
    if (!isPlainObject(entry))
      return { status: "hold", reason: "unsafe-profile", schemaVersion: version };
    const parsed = parseProfile(stripSecrets(entry));
    if (!parsed.ok) return { status: "hold", reason: "unsafe-profile", schemaVersion: version };
    if (seen.has(parsed.value.id))
      return { status: "hold", reason: "unsafe-profile", schemaVersion: version };
    seen.add(parsed.value.id);
    if (isBuiltinDirectProfile(parsed.value.id)) {
      if (parsed.value.proxy.type !== "direct")
        return {
          status: "hold",
          reason: "unsafe-profile",
          schemaVersion: Number(raw.schemaVersion),
        };
    } else profiles.push(parsed.value);
  }

  let activeProfileId: string | null;
  if (raw.activeProfileId === undefined || raw.activeProfileId === null) {
    activeProfileId = null;
  } else if (typeof raw.activeProfileId !== "string") {
    return { status: "hold", reason: "unsafe-profile", schemaVersion: version };
  } else {
    if (!seen.has(raw.activeProfileId) && !isBuiltinDirectProfile(raw.activeProfileId)) {
      return { status: "hold", reason: "unsafe-profile", schemaVersion: version };
    }
    activeProfileId = raw.activeProfileId;
  }

  let appliedSelection: AppliedSelection | null;
  if (version >= 3) {
    const parsed = parseAppliedSelection(stripSecretsDeep(raw.appliedSelection), activeProfileId);
    if (!parsed.ok) return { status: "hold", reason: "unsafe-profile", schemaVersion: version };
    appliedSelection = parsed.value;
  } else if (activeProfileId === null) appliedSelection = null;
  else if (isBuiltinDirectProfile(activeProfileId)) appliedSelection = { kind: "builtin-direct" };
  else {
    const profile = profiles.find((candidate) => candidate.id === activeProfileId);
    if (profile === undefined)
      return { status: "hold", reason: "unsafe-profile", schemaVersion: version };
    // In v1/v2, an active user profile saved as Direct might still have a
    // previously applied proxy. That distinction was not stored. Block it.
    appliedSelection =
      profile.proxy.type === "direct"
        ? { kind: "unresolved", profileId: activeProfileId }
        : { kind: "profile", profile };
  }

  const state: ProfileState = ensureBuiltinDirect({
    schemaVersion: SCHEMA_VERSION,
    activeProfileId,
    appliedSelection,
    profiles,
  });
  return {
    status: "ready",
    state,
    persist: JSON.stringify(raw) !== JSON.stringify(durableProfileState(state)),
  };
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
