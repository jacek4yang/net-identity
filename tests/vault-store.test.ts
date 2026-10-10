import { describe, expect, it } from "vitest";
import { VaultStore, VAULT_KEY, VAULT_PREVIOUS_KEY, VAULT_SESSION_KEY } from "../src/vault/store";
import { ACTIVE_TARGET_KEY, CREDENTIAL_KEY_PREFIX, STORAGE_KEY } from "../src/shared/constants";
import { createMemoryStorage, makeProfile, createHarness } from "./helpers";
import { EMPTY_PROFILE_STATE, durableProfileState } from "../src/profile/schema";
import { createProfileStore, setActiveProfile, upsertProfile } from "../src/profile/store";

const password = "correct horse battery staple";
const credentialKey = `${CREDENTIAL_KEY_PREFIX}proxy-aaa`;
async function fixture(active = false) {
  const local = createMemoryStorage();
  const session = createMemoryStorage({
    [credentialKey]: { username: "private-user", password: "private-pass" },
  });
  const store = createProfileStore(local);
  const profile = makeProfile({ id: "proxy-aaa", name: "Private endpoint" });
  await store.mutate((state) => upsertProfile(state, profile));
  if (active) await store.mutate((state) => setActiveProfile(state, profile.id, profile));
  await store.load();
  return { local, session, vault: new VaultStore(local, session), profile };
}

describe("vault migration and lifecycle", () => {
  it("encrypts existing profiles and credentials; keeps no durable decryption key", async () => {
    const { local, session, vault } = await fixture();
    const before = await local.get(STORAGE_KEY);
    await vault.setup(password);
    expect(await vault.status()).toBe("unlocked");
    expect(await vault.profiles.get(STORAGE_KEY)).toEqual(before);
    expect(await vault.secrets.get(credentialKey)).toEqual({
      [credentialKey]: { username: "private-user", password: "private-pass" },
    });
    for (const text of [
      "private-user",
      "private-pass",
      "Private endpoint",
      "127.0.0.1",
      password,
      VAULT_SESSION_KEY,
    ])
      expect(local.serialized()).not.toContain(text);
    expect(session.snapshot()[credentialKey]).toBeUndefined();
    expect(local.snapshot()[STORAGE_KEY]).toEqual({ schemaVersion: 5, encryptedVault: true });
  });
  it("survives event-page replacement without password and full exit with explicit unlock", async () => {
    const { local, session, vault } = await fixture(true);
    await vault.setup(password);
    const sameSession = new VaultStore(local, session);
    expect(await sameSession.status()).toBe("unlocked");
    expect((await sameSession.secrets.get(credentialKey))[credentialKey]).toBeDefined();
    await session.clear();
    const nextSession = new VaultStore(local, session);
    expect(await nextSession.status()).toBe("locked");
    await expect(nextSession.profiles.get(STORAGE_KEY)).rejects.toThrow("Unlock");
    const preserved = local.serialized();
    await expect(nextSession.unlock("incorrect horse battery staple")).rejects.toThrow();
    expect(local.serialized()).toBe(preserved);
    await nextSession.unlock(password);
    expect(await nextSession.profiles.get(STORAGE_KEY)).toEqual(
      await vault.profiles.get(STORAGE_KEY),
    );
  });
  it("preserves Off while locked but rejects edits and credential reads", async () => {
    const { local, session, vault } = await fixture(false);
    await vault.setup(password);
    await session.clear();
    const locked = new VaultStore(local, session);
    expect(await locked.profiles.get(STORAGE_KEY)).toEqual({
      [STORAGE_KEY]: durableProfileState(EMPTY_PROFILE_STATE),
    });
    await expect(locked.profiles.set({ [STORAGE_KEY]: EMPTY_PROFILE_STATE })).rejects.toThrow();
    await expect(locked.secrets.get(credentialKey)).rejects.toThrow();
  });
  it("serializes overlapping writes and retains a recoverable ciphertext revision", async () => {
    const { local, vault } = await fixture();
    await vault.setup(password);
    await Promise.all([
      vault.secrets.set({
        [`${CREDENTIAL_KEY_PREFIX}profile-one`]: { username: "one", password: "one" },
      }),
      vault.secrets.set({
        [`${CREDENTIAL_KEY_PREFIX}profile-two`]: { username: "two", password: "two" },
      }),
    ]);
    expect(Object.keys(await vault.secrets.get(null))).toHaveLength(3);
    expect(local.snapshot()[VAULT_PREVIOUS_KEY]).toBeDefined();
    expect(await vault.backup()).not.toContain("private-pass");
  });
  it("exports and restores on an empty installation without replacing existing data", async () => {
    const { vault } = await fixture(true);
    await vault.setup(password);
    const backup: unknown = JSON.parse(await vault.backup());
    const restored = new VaultStore(createMemoryStorage(), createMemoryStorage());
    await restored.restore(backup, password);
    expect(await restored.profiles.get(null)).toEqual(await vault.profiles.get(null));
    expect(await restored.secrets.get(null)).toEqual(await vault.secrets.get(null));
    await expect(restored.restore(backup, password)).rejects.toThrow("empty installation");
    const existing = await fixture();
    const original = existing.local.serialized();
    await expect(existing.vault.restore(backup, password)).rejects.toThrow();
    expect(existing.local.serialized()).toBe(original);
  });
  it("leaves unsupported legacy data unchanged and refuses overwrite of a future vault", async () => {
    const local = createMemoryStorage({
      [STORAGE_KEY]: { schemaVersion: 99, profiles: ["preserve"] },
    });
    const vault = new VaultStore(local, createMemoryStorage());
    const original = local.serialized();
    await expect(vault.setup(password)).rejects.toThrow("preserved");
    expect(local.serialized()).toBe(original);
    await local.set({ [VAULT_KEY]: { version: 2 } });
    const future = local.serialized();
    expect(await vault.status()).toBe("damaged");
    await expect(vault.setup(password)).rejects.toThrow();
    await expect(vault.profiles.set({ [STORAGE_KEY]: EMPTY_PROFILE_STATE })).rejects.toThrow();
    expect(local.serialized()).toBe(future);
  });
  it("keeps legacy profiles when initial encrypted commit fails", async () => {
    const { local, session } = await fixture();
    const original = local.serialized();
    const vault = new VaultStore(
      {
        ...local,
        set: async () => {
          throw new Error("disk full");
        },
      },
      session,
    );
    await expect(vault.setup(password)).rejects.toThrow("disk full");
    expect(local.serialized()).toBe(original);
    expect(session.snapshot()[credentialKey]).toBeDefined();
  });
  it("never silently downgrades encryption or accepts unrelated keys", async () => {
    const { vault } = await fixture();
    await vault.setup(password);
    await expect(vault.profiles.set({ dangerous: "value" })).rejects.toThrow();
    await expect(vault.secrets.set({ [ACTIVE_TARGET_KEY]: { invalid: true } })).rejects.toThrow();
  });
});

describe("vault routing boundary", () => {
  it("unlocks the applied route and applied credentials, never newer saved-only edits", async () => {
    const local = createMemoryStorage();
    const session = createMemoryStorage();
    const vault = new VaultStore(local, session);
    const harness = (v: VaultStore) =>
      createHarness({
        localArea: {
          ...v.profiles,
          snapshot: () => local.snapshot(),
          serialized: () => local.serialized(),
        },
        sessionArea: {
          ...v.secrets,
          snapshot: () => session.snapshot(),
          serialized: () => session.serialized(),
        },
      });
    const first = harness(vault);
    const profile = makeProfile({
      id: "profile-one",
      proxy: {
        type: "socks5",
        host: "127.0.0.1",
        port: 1080,
        proxyDNS: true,
        bypassHosts: [],
        authenticationRequired: true,
      },
    });
    await first.saveProfile(profile);
    await first.credentialStore.set(profile.id, {
      username: "applied-user",
      password: "applied-secret",
    });
    await first.controller.activate(profile.id);
    await first.saveProfile({ ...profile, proxy: { ...profile.proxy, port: 9999 }, revision: 2 });
    await first.credentialStore.set(profile.id, {
      username: "new-saved-user",
      password: "new-saved-secret",
    });
    await vault.setup(password);
    await session.clear();
    const resumedVault = new VaultStore(local, session);
    const resumed = harness(resumedVault);
    await resumed.controller.initialize();
    expect(await resumed.controller.shouldBlockRequest("https://example.test/")).toBe(true);
    await resumedVault.unlock(password);
    await resumed.controller.initialize();
    expect(await resumed.controller.shouldBlockRequest("https://example.test/")).toBe(false);
    expect(resumed.controller.getTarget()?.proxy.port).toBe(1080);
    expect(resumed.controller.getTarget()?.credentials?.username).toBe("applied-user");
    expect(
      (await resumed.profileStore.load()).profiles.find((p) => p.id === profile.id)?.proxy.port,
    ).toBe(9999);
    expect((await resumed.credentialStore.get(profile.id))?.username).toBe("new-saved-user");
    expect(resumed.providerResolveCount()).toBe(0);
    expect(resumed.webrtcSetting.setCalls).toBe(0);
  });
});
