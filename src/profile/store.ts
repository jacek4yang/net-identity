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
  type IdentityProfile,
  type ProfileState,
} from "./schema";
import { parseProfileState } from "./validation";

export interface ProfileStore {
  /** Always resolves; unreadable or corrupt state degrades to an empty state. */
  load(): Promise<ProfileState>;
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

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  };

  // Called from inside the queue, so it must not enqueue again.
  const readState = async (): Promise<ProfileState> =>
    parseStoredState(await readKey(area, STORAGE_KEY));
  const writeState = async (state: ProfileState): Promise<void> => {
    await area.set({ [STORAGE_KEY]: state });
  };

  return {
    load: () => enqueue(readState),

    save: (state) => enqueue(() => writeState(state)),

    mutate: (apply) =>
      enqueue(async () => {
        const result = apply(await readState());
        if (!result.ok) return result;
        await writeState(result.value);
        return result;
      }),
  };
}

/**
 * Parse-or-empty: corrupt or unreadable stored data must never break the
 * background script, so a bad state degrades to an empty one.
 */
export function parseStoredState(raw: unknown): ProfileState {
  const parsed = parseProfileState(raw);
  return parsed.ok ? parsed.value : structuredClone(EMPTY_PROFILE_STATE);
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
  return state.profiles.find((profile) => profile.id === profileId) ?? null;
}

export function upsertProfile(state: ProfileState, profile: IdentityProfile): Result<ProfileState> {
  const existingIndex = state.profiles.findIndex((candidate) => candidate.id === profile.id);
  if (existingIndex === -1 && state.profiles.length >= MAX_PROFILES) {
    return { ok: false, errors: [`profile limit reached (max ${MAX_PROFILES})`] };
  }
  const profiles = [...state.profiles];
  if (existingIndex === -1) profiles.push(profile);
  else profiles[existingIndex] = profile;
  return {
    ok: true,
    value: {
      schemaVersion: SCHEMA_VERSION,
      activeProfileId: state.activeProfileId,
      profiles,
    },
  };
}

export function removeProfile(state: ProfileState, profileId: string): ProfileState {
  return {
    schemaVersion: SCHEMA_VERSION,
    activeProfileId: state.activeProfileId === profileId ? null : state.activeProfileId,
    profiles: state.profiles.filter((profile) => profile.id !== profileId),
  };
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
