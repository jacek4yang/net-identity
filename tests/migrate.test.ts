import { describe, expect, it } from "vitest";
import { migrateStoredProfileState } from "../src/profile/migrate";
import {
  BUILTIN_DIRECT_PROFILE_ID,
  SCHEMA_VERSION,
  durableProfileState,
} from "../src/profile/schema";
import { STORAGE_KEY } from "../src/shared/constants";
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

    expect(idle.status).toBe("idle");
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

    expect(state.status).toBe("idle");
    expect(state.activeProfileId).toBeNull();
    expect(state.proxy.configured).toBe(false);
    expect(harness.controller.getTarget()).toBeNull();
    expect(area.serialized()).toBe(before);
    expect(state.lastError?.code).toBe("schema_unsupported");
  });
});
