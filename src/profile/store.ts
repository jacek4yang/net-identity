/**
 * Profile persistence.
 *
 * Non-secret profile data lives in `browser.storage.local` under a single
 * versioned key. Secrets never reach this module (see `src/background/credentials.ts`).
 *
 * Mutations are expressed as pure state transitions plus one small serialising
 * store, so there is exactly one read-modify-write implementation and concurrent
 * callers cannot lose each other's updates.
 */
import { MAX_PROFILES, STORAGE_KEY } from "../shared/constants";
import { type Result } from "../shared/result";
import { readKey, type StorageAreaLike } from "../shared/storage";
import {
  EMPTY_PROFILE_STATE,
  SCHEMA_VERSION,
  ensureBuiltinDirect,
  durableProfileState,
  isBuiltinDirectProfile,
  createBuiltinDirectProfile,
  canStoreMoreProfiles,
  type IdentityProfile,
  type ProfileState,
} from "./schema";
import { migrateStoredProfileState, migrationHoldMessage } from "./migrate";

export interface ProfileStore {
  /**
   * The profiles this build may use. A document that must not be overwritten is
   * reported as empty here; `migrationWarning()` explains why, and `save` /
   * `mutate` refuse to replace the stored bytes.
   */
  load(): Promise<ProfileState>;
  /** Set after `load` or a refused write when storage was left unchanged on purpose. */
  migrationWarning(): string | null;
  save(state: ProfileState): Promise<void>;
  /**
   * Atomic read-modify-write.
   *
   * A separate load() followed by save() loses concurrent updates: two callers read
   * the same state and the last write wins. Every mutation therefore goes through
   * this queue, which performs the read, the transition and the write as one step.
   */
  mutate(apply: (state: ProfileState) => Result<ProfileState>): Promise<Result<ProfileState>>;
}

export function createProfileStore(area: StorageAreaLike): ProfileStore {
  let queue: Promise<unknown> = Promise.resolve();
  let warning: string | null = null;

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  };

  // Called from inside the queue, so it must not enqueue again.
  const readMigration = async () => migrateStoredProfileState(await readKey(area, STORAGE_KEY));

  const accept = async (
    migrated: ReturnType<typeof migrateStoredProfileState>,
  ): Promise<ProfileState | null> => {
    if (migrated.status === "hold") {
      warning = migrationHoldMessage(migrated);
      return null;
    }
    warning = null;
    const state = ensureBuiltinDirect(migrated.state);
    if (migrated.persist) {
      await area.set({ [STORAGE_KEY]: durableProfileState(state) });
    }
    return state;
  };

  return {
    load: () =>
      enqueue(async () => {
        const state = await accept(await readMigration());
        return ensureBuiltinDirect(state ?? structuredClone(EMPTY_PROFILE_STATE));
      }),

    migrationWarning: () => warning,

    save: (state) =>
      enqueue(async () => {
        const current = await accept(await readMigration());
        if (current === null) return;
        await area.set({ [STORAGE_KEY]: durableProfileState(state) });
      }),

    mutate: (apply) =>
      enqueue(async () => {
        const current = await accept(await readMigration());
        if (current === null) {
          return {
            ok: false as const,
            errors: [warning ?? "Stored profiles were left unchanged."],
          };
        }
        const ensuredCurrent = ensureBuiltinDirect(current);
        const result = apply(ensuredCurrent);
        if (!result.ok) return result;
        const finalState = ensureBuiltinDirect(result.value);
        await area.set({ [STORAGE_KEY]: durableProfileState(finalState) });
        return { ok: true, value: finalState };
      }),
  };
}

/**
 * Applies a state transition atomically.
 *
 * Thin wrapper over `ProfileStore.mutate` so call sites read as domain operations;
 * the atomicity guarantee lives in the store, not in the caller.
 */
export function mutateProfiles(
  store: ProfileStore,
  apply: (state: ProfileState) => Result<ProfileState>,
): Promise<Result<ProfileState>> {
  return store.mutate(apply);
}

export function findProfile(state: ProfileState, profileId: string | null): IdentityProfile | null {
  if (profileId === null) return null;
  if (isBuiltinDirectProfile(profileId)) return createBuiltinDirectProfile();
  return state.profiles.find((profile) => profile.id === profileId) ?? null;
}

export function upsertProfile(state: ProfileState, profile: IdentityProfile): Result<ProfileState> {
  if (isBuiltinDirectProfile(profile.id)) {
    return { ok: false, errors: ["The built-in Direct route is read-only."] };
  }

  const existingIndex = state.profiles.findIndex((candidate) => candidate.id === profile.id);
  if (existingIndex === -1 && !canStoreMoreProfiles(state)) {
    return { ok: false, errors: [`profile limit reached (max ${MAX_PROFILES})`] };
  }
  const profiles = [...state.profiles];
  if (existingIndex === -1) profiles.push(profile);
  else profiles[existingIndex] = profile;
  return {
    ok: true,
    value: ensureBuiltinDirect({
      schemaVersion: SCHEMA_VERSION,
      activeProfileId: state.activeProfileId,
      profiles,
    }),
  };
}

export function removeProfile(state: ProfileState, profileId: string): ProfileState {
  if (isBuiltinDirectProfile(profileId)) {
    return state;
  }
  return ensureBuiltinDirect({
    schemaVersion: SCHEMA_VERSION,
    activeProfileId: state.activeProfileId === profileId ? null : state.activeProfileId,
    profiles: state.profiles.filter((profile) => profile.id !== profileId),
  });
}

export function setActiveProfile(
  state: ProfileState,
  profileId: string | null,
): Result<ProfileState> {
  if (profileId !== null && findProfile(state, profileId) === null) {
    return { ok: false, errors: ["profile not found"] };
  }
  return {
    ok: true,
    value: { schemaVersion: SCHEMA_VERSION, activeProfileId: profileId, profiles: state.profiles },
  };
}

export function createProfileId(): string {
  return globalThis.crypto.randomUUID();
}
