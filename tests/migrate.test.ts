import { describe, expect, it } from "vitest";
import { migrateStoredProfileState } from "../src/profile/migrate";
import {
  BUILTIN_DIRECT_PROFILE_ID,
  SCHEMA_VERSION,
  durableProfileState,
} from "../src/profile/schema";
import { ACTIVE_TARGET_KEY, STORAGE_KEY } from "../src/shared/constants";
import { createHarness, createMemoryStorage, makeProfile } from "./helpers";

const PASSWORD = "session-secret-value";

function version1Document(
  profile: ReturnType<typeof makeProfile>,
  extra: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1,
    activeProfileId: profile.id,
    profiles: [{ ...profile, ...extra }],
  };
}

describe("profile schema migration", () => {
  it("keeps legacy applied session credentials through the schema upgrade", async () => {
    const profile = makeProfile({
      id: "v3-session-upgrade",
      proxy: {
        type: "socks5",
        host: "127.0.0.1",
        port: 1080,
        proxyDNS: true,
        bypassHosts: [],
        authenticationRequired: true,
      },
    });
    const h = createHarness();
    await h.saveProfile(profile);
    await h.credentialStore.set(profile.id, { username: "session-only-user", password: PASSWORD });
    await h.controller.activate(profile.id);
    const snapshot = await h.targetStore.load();
    expect(snapshot?.profile).toBeDefined();
    if (snapshot?.profile === undefined) return;
    const { authenticationRequired: _marker, ...proxy } = snapshot.proxy;
    const legacyProxy = { ...proxy, username: "session-only-user" };
    const legacyProfile = { ...snapshot.profile, proxy: legacyProxy };
    await h.localArea.set({
      [STORAGE_KEY]: {
        schemaVersion: 3,
        activeProfileId: profile.id,
        profiles: [legacyProfile],
        appliedSelection: { kind: "profile", profile: legacyProfile },
      },
    });
    await h.sessionArea.set({
      [ACTIVE_TARGET_KEY]: { ...snapshot, profile: legacyProfile, proxy: legacyProxy },
    });
    const resumed = createHarness({ localArea: h.localArea, sessionArea: h.sessionArea });
    await resumed.controller.initialize();
    expect(resumed.controller.getTarget()?.credentials).toEqual({
      username: "session-only-user",
      password: PASSWORD,
    });
    expect(resumed.controller.getTarget()?.proxy.authenticationRequired).toBe(true);
    expect(h.localArea.serialized()).not.toContain("session-only-user");
    expect(h.localArea.serialized()).not.toContain(PASSWORD);
  });
  it("migrates v3 usernames without replacing an applied proxy with newer saved Direct", async () => {
    const profile = makeProfile({ id: "v3-credential-route", revision: 2 });
    const applied = {
      ...profile,
      revision: 1,
      proxy: { ...profile.proxy, username: "applied-secret-user", password: PASSWORD },
    };
    const saved = { ...profile, proxy: { type: "direct", proxyDNS: false, bypassHosts: [] } };
    const localArea = createMemoryStorage({
      [STORAGE_KEY]: {
        schemaVersion: 3,
        activeProfileId: profile.id,
        profiles: [saved],
        appliedSelection: { kind: "profile", profile: applied },
      },
    });
    const h = createHarness({ localArea });
    const stored = await h.profileStore.load();
    expect(stored.schemaVersion).toBe(4);
    expect(stored.profiles.find((p) => p.id === profile.id)?.proxy.type).toBe("direct");
    expect(stored.appliedSelection).toMatchObject({
      kind: "profile",
      profile: {
        revision: 1,
        proxy: { type: "http", authenticationRequired: true },
      },
    });
    expect(localArea.serialized()).not.toContain("applied-secret-user");
    expect(localArea.serialized()).not.toContain("username");
    expect(localArea.serialized()).not.toContain(PASSWORD);
    const state = await h.controller.initialize();
    expect(state.desiredRoute).toBe("proxy");
    expect(h.controller.getTarget()?.proxy.type).toBe("http");
    expect(h.controller.getTarget()?.credentials).toBeNull();
    const once = localArea.serialized();
    await h.profileStore.load();
    expect(localArea.serialized()).toBe(once);
  });
  it("scrubs different usernames independently from saved and applied v3 proxies", () => {
    const profile = makeProfile({ id: "v3-two-usernames" });
    const result = migrateStoredProfileState({
      schemaVersion: 3,
      activeProfileId: profile.id,
      profiles: [{ ...profile, proxy: { ...profile.proxy, username: "saved-user" } }],
      appliedSelection: {
        kind: "profile",
        profile: { ...profile, proxy: { ...profile.proxy, username: "applied-user" } },
      },
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.state.profiles[1]?.proxy.authenticationRequired).toBe(true);
    expect(result.state.appliedSelection).toMatchObject({
      profile: { proxy: { authenticationRequired: true } },
    });
    expect(JSON.stringify(result.state)).not.toMatch(/saved-user|applied-user|"username"/);
  });
  it("migrates a v2 active proxy into a credential-free applied route", () => {
    const profile = makeProfile({ id: "v2-proxy-route" });
    const result = migrateStoredProfileState({
      schemaVersion: 2,
      activeProfileId: profile.id,
      profiles: [profile],
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.state.appliedSelection).toMatchObject({
      kind: "profile",
      profile: { id: profile.id, proxy: profile.proxy },
    });
    expect(JSON.stringify(durableProfileState(result.state))).not.toContain("password");
  });
  it("blocks an ambiguous v2 active user Direct profile after migration", async () => {
    const profile = makeProfile({
      id: "ambiguous-direct",
      proxy: {
        type: "direct",
        proxyDNS: false,
        bypassHosts: [],
      },
    });
    const localArea = createMemoryStorage({
      [STORAGE_KEY]: {
        schemaVersion: 2,
        activeProfileId: profile.id,
        profiles: [profile],
      },
    });
    const fresh = createHarness({ localArea });
    expect(await fresh.controller.shouldBlockRequest("https://example.invalid/")).toBe(true);
    const state = await fresh.controller.initialize();
    expect(state.activeProfileId).toBe(profile.id);
    expect(state.appliedRoute).toBe("blocked");
    expect(state.lastError?.code).toBe("routing_unresolved");
  });
  it("holds a v3 active document without a valid applied route byte-for-byte", async () => {
    const profile = makeProfile({ id: "broken-applied" });
    const area = createMemoryStorage({
      [STORAGE_KEY]: {
        schemaVersion: SCHEMA_VERSION,
        activeProfileId: profile.id,
        appliedSelection: {
          kind: "profile",
          profile: {
            ...profile,
            proxy: {
              type: "http",
              host: "",
              port: 0,
              proxyDNS: false,
              bypassHosts: [],
            },
          },
        },
        profiles: [profile],
      },
    });
    const before = area.serialized();
    const h = createHarness({ localArea: area });
    expect(await h.controller.shouldBlockRequest("https://example.invalid/")).toBe(true);
    expect((await h.controller.initialize()).lastError?.code).toBe("schema_unsupported");
    expect(area.serialized()).toBe(before);
  });
  it("preserves version-1 manual choices and makes policy defaults explicit", () => {
    const profile = makeProfile({
      id: "migrate-manual",
      identity: {
        mode: "manual",
        latitude: 0,
        longitude: 180,
        accuracy: 500,
        timezone: "Pacific/Auckland",
      },
      webrtcPolicy: "default_public_interface_only",
    });
    const result = migrateStoredProfileState(version1Document(profile));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.state.profiles[1]).toMatchObject({
      revision: 1,
      webrtcMode: "manual",
      webrtcPolicy: "default_public_interface_only",
      identity: {
        geolocationPolicy: "manual",
        timezonePolicy: "manual",
        geoIpPolicy: "automatic",
        providerId: "ipwho.is",
        longitude: 180,
      },
    });
    expect(durableProfileState(result.state).profiles).toHaveLength(1);
  });
  it("holds a reserved Direct record that would discard a proxy", () => {
    const result = migrateStoredProfileState(
      version1Document(makeProfile({ id: BUILTIN_DIRECT_PROFILE_ID })),
    );
    expect(result.status).toBe("hold");
  });
  it("rejects malformed version-2 policies without rewriting storage", async () => {
    const stored = {
      schemaVersion: 2,
      activeProfileId: "policy-unsafe",
      profiles: [
        {
          ...makeProfile({ id: "policy-unsafe" }),
          identity: { mode: "auto", geoIpPolicy: "fallback-direct" },
        },
      ],
    };
    const area = createMemoryStorage({ [STORAGE_KEY]: stored });
    const before = area.serialized();
    const h = createHarness({ localArea: area });
    expect((await h.controller.initialize()).lastError?.code).toBe("schema_unsupported");
    expect(area.serialized()).toBe(before);
  });
  it("is idempotent and strips passwords from a version 1 document", () => {
    const profile = makeProfile({ id: "profile-0001", name: "Amsterdam" });
    const stored = version1Document(profile, {
      password: PASSWORD,
      proxy: { ...profile.proxy, password: PASSWORD },
    });

    const first = migrateStoredProfileState(stored);
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;
    expect(first.persist).toBe(true);
    expect(first.state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(first.state.activeProfileId).toBe(profile.id);
    expect(first.state.profiles[0]?.id).toBe(BUILTIN_DIRECT_PROFILE_ID);
    expect(first.state.profiles[1]?.proxy).toEqual(profile.proxy);
    expect(JSON.stringify(first.state)).not.toContain(PASSWORD);

    const second = migrateStoredProfileState(durableProfileState(first.state));
    expect(second).toEqual({ status: "ready", state: first.state, persist: false });
  });

  it("migrates an unversioned document with the version 1 shape", () => {
    const profile = makeProfile({ id: "profile-0002" });
    const stored = version1Document(profile);
    delete (stored as { schemaVersion?: number }).schemaVersion;
    const migrated = migrateStoredProfileState(stored);
    expect(migrated.status).toBe("ready");
    if (migrated.status !== "ready") return;
    expect(migrated.state.profiles[0]?.id).toBe(BUILTIN_DIRECT_PROFILE_ID);
    expect(migrated.state.profiles[1]?.proxy.type).toBe("http");
    expect(migrated.state.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("does not turn a proxied profile into a direct connection when the host is missing", () => {
    const stored = {
      schemaVersion: 1,
      activeProfileId: "profile-0003",
      profiles: [
        {
          id: "profile-0003",
          name: "Missing host",
          proxy: { type: "http", proxyDNS: false, bypassHosts: ["localhost"] },
          identity: { mode: "auto" },
          webrtcPolicy: "disable_non_proxied_udp",
        },
      ],
    };
    const migrated = migrateStoredProfileState(stored);
    expect(migrated).toEqual({ status: "hold", reason: "unsafe-profile", schemaVersion: 1 });
  });

  it("holds a newer schema without reading its profiles", () => {
    const stored = {
      schemaVersion: 7,
      activeProfileId: "profile-0004",
      profiles: [{ password: PASSWORD }],
    };
    expect(migrateStoredProfileState(stored)).toEqual({
      status: "hold",
      reason: "future-schema",
      schemaVersion: 7,
    });
  });

  it("activates a migrated HTTP profile and leaves a future document idle", async () => {
    const profile = makeProfile({ id: "profile-0005", name: "Kept proxy" });
    const area = createMemoryStorage({
      [STORAGE_KEY]: version1Document(profile, { password: PASSWORD }),
    });
    const harness = createHarness({ localArea: area });
    const state = await harness.controller.initialize();

    expect(state.status).toBe("ready");
    expect(state.activeProfileId).toBe(profile.id);
    expect(state.proxy.configured).toBe(true);
    expect(harness.controller.getTarget()?.proxy.type).toBe("http");
    expect(harness.controller.getTarget()?.proxy.host).toBe("127.0.0.1");
    expect(area.serialized()).not.toContain(PASSWORD);
    expect(harness.profileStore.migrationWarning()).toBeNull();

    const future = {
      schemaVersion: 9,
      activeProfileId: profile.id,
      profiles: [{ ...profile, password: PASSWORD }],
    };
    const futureArea = createMemoryStorage({ [STORAGE_KEY]: future });
    const before = futureArea.serialized();
    const held = createHarness({ localArea: futureArea });
    const idle = await held.controller.initialize();

    expect(idle.status).toBe("error");
    expect(idle.activeProfileId).toBeNull();
    expect(idle.lastError?.code).toBe("schema_unsupported");
    expect(held.controller.getTarget()).toBeNull();
    expect(futureArea.serialized()).toBe(before);
    expect(futureArea.serialized()).toContain(PASSWORD);
  });

  it("does not rewrite a profile whose proxy host is missing", async () => {
    const stored = {
      schemaVersion: 1,
      activeProfileId: "profile-0006",
      profiles: [
        {
          id: "profile-0006",
          name: "Missing host",
          proxy: { type: "socks5", proxyDNS: true, bypassHosts: ["localhost"] },
          identity: { mode: "auto" },
          webrtcPolicy: "proxy_only",
        },
      ],
    };
    const area = createMemoryStorage({ [STORAGE_KEY]: stored });
    const before = area.serialized();
    const harness = createHarness({ localArea: area });
    const state = await harness.controller.initialize();

    expect(state.status).toBe("error");
    expect(state.activeProfileId).toBeNull();
    expect(state.proxy.configured).toBe(false);
    expect(harness.controller.getTarget()).toBeNull();
    expect(area.serialized()).toBe(before);
    expect(state.lastError?.code).toBe("schema_unsupported");
  });
});
