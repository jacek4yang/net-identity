import { describe, expect, it } from "vitest";
import { MAX_PROFILES } from "../src/shared/constants";
import {
  EMPTY_PROFILE_STATE,
  SCHEMA_VERSION,
  createProfile,
  type ProfileState,
} from "../src/profile/schema";
import {
  createProfileId,
  createProfileStore,
  findProfile,
  mutateProfiles,
  removeProfile,
  setActiveProfile,
  upsertProfile,
} from "../src/profile/store";
import { parseProfile } from "../src/profile/validation";
import { STORAGE_KEY } from "../src/shared/constants";
import { createMemoryStorage, makeProfile } from "./helpers";

describe("profile store", () => {
  it("round-trips profiles through a storage area", async () => {
    const store = createProfileStore(createMemoryStorage());
    const profile = makeProfile({ id: "profile-0001", name: "Amsterdam" });

    await store.save({
      schemaVersion: SCHEMA_VERSION,
      activeProfileId: profile.id,
      profiles: [profile],
    });
    const loaded = await store.load();

    expect(loaded.activeProfileId).toBe("profile-0001");
    expect(loaded.profiles).toEqual([profile]);
  });

  it("degrades to an empty state when stored data is corrupt", async () => {
    const store = createProfileStore(
      createMemoryStorage({
        [STORAGE_KEY]: {
          schemaVersion: SCHEMA_VERSION,
          activeProfileId: "profile-0002",
          profiles: "nope",
        },
      }),
    );
    expect(await store.load()).toEqual(EMPTY_PROFILE_STATE);
  });

  it("leaves a newer schema untouched and refuses to overwrite it", async () => {
    const stored = {
      schemaVersion: 42,
      activeProfileId: "profile-0001",
      profiles: [makeProfile({ id: "profile-0001", name: "future" })],
    };
    const area = createMemoryStorage({ [STORAGE_KEY]: stored });
    const before = area.serialized();
    const store = createProfileStore(area);

    expect(await store.load()).toEqual(EMPTY_PROFILE_STATE);
    expect(store.migrationWarning()).toContain("42");
    expect(area.serialized()).toBe(before);

    const written = await mutateProfiles(store, (state) =>
      upsertProfile(state, makeProfile({ id: "profile-0008" })),
    );
    expect(written.ok).toBe(false);
    expect(area.serialized()).toBe(before);
  });

  it("serialises concurrent mutations without losing updates", async () => {
    const store = createProfileStore(createMemoryStorage());

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        mutateProfiles(store, (state) =>
          upsertProfile(state, makeProfile({ id: `profile-10${index}`, name: `profile ${index}` })),
        ),
      ),
    );

    const loaded = await store.load();
    expect(loaded.profiles).toHaveLength(8);
    expect(new Set(loaded.profiles.map((profile) => profile.id)).size).toBe(8);
  });

  it("enforces the profile limit", async () => {
    const store = createProfileStore(createMemoryStorage());
    const profiles = Array.from({ length: MAX_PROFILES }, (_, index) =>
      makeProfile({ id: `profile-${String(index).padStart(5, "0")}` }),
    );
    await store.save({ schemaVersion: SCHEMA_VERSION, activeProfileId: null, profiles });

    const result = await mutateProfiles(store, (state) =>
      upsertProfile(state, makeProfile({ id: "profile-99999" })),
    );
    expect(result.ok).toBe(false);
  });

  it("replaces an existing profile in place", async () => {
    const store = createProfileStore(createMemoryStorage());
    const profile = makeProfile({ id: "profile-0003", name: "first" });
    await mutateProfiles(store, (state) => upsertProfile(state, profile));
    await mutateProfiles(store, (state) => upsertProfile(state, { ...profile, name: "second" }));

    const loaded = await store.load();
    expect(loaded.profiles).toHaveLength(1);
    expect(loaded.profiles[0]?.name).toBe("second");
  });

  it("clears the active pointer when the active profile is removed", async () => {
    const profile = makeProfile({ id: "profile-0004" });
    const state: ProfileState = {
      schemaVersion: SCHEMA_VERSION,
      activeProfileId: profile.id,
      profiles: [profile],
    };
    const next = removeProfile(state, profile.id);

    expect(next.activeProfileId).toBeNull();
    expect(next.profiles).toHaveLength(0);
  });

  it("refuses to activate an unknown profile", () => {
    const state: ProfileState = {
      schemaVersion: SCHEMA_VERSION,
      activeProfileId: null,
      profiles: [],
    };
    expect(setActiveProfile(state, "profile-0005").ok).toBe(false);
    expect(setActiveProfile(state, null).ok).toBe(true);
  });

  it("finds profiles and tolerates a null id", () => {
    const profile = makeProfile({ id: "profile-0006" });
    const state: ProfileState = {
      schemaVersion: SCHEMA_VERSION,
      activeProfileId: null,
      profiles: [profile],
    };
    expect(findProfile(state, profile.id)?.id).toBe(profile.id);
    expect(findProfile(state, null)).toBeNull();
    expect(findProfile(state, "profile-0007")).toBeNull();
  });

  it("generates ids that satisfy profile validation", () => {
    const id = createProfileId();
    const parsed = parseProfile(createProfile(id, "generated"));
    expect(parsed.ok).toBe(true);
  });
});
