import { describe, expect, it } from "vitest";
import {
  createCredentialStore,
  credentialKey,
  credentialProfileIdFromKey,
} from "../src/background/credentials";
import { createProfileStore } from "../src/profile/store";
import { SCHEMA_VERSION } from "../src/profile/schema";
import { createMemoryStorage, makeProfile } from "./helpers";

describe("credential store", () => {
  it("stores credentials under a per-profile key", async () => {
    const area = createMemoryStorage();
    const store = createCredentialStore(area);

    await store.set("profile-0001", { username: "user", password: "page-secret" });

    expect(credentialKey("profile-0001") in area.snapshot()).toBe(true);
    expect(await store.get("profile-0001")).toEqual({ username: "user", password: "page-secret" });
    expect(await store.has("profile-0001")).toBe(true);
  });

  it("removes credentials when both fields are empty", async () => {
    const store = createCredentialStore(createMemoryStorage());
    await store.set("profile-0002", { username: "user", password: "pw" });
    await store.set("profile-0002", { username: "", password: "" });

    expect(await store.get("profile-0002")).toBeNull();
    expect(await store.has("profile-0002")).toBe(false);
  });

  it("ignores corrupt stored values instead of throwing", async () => {
    const store = createCredentialStore(
      createMemoryStorage({ [credentialKey("profile-0003")]: { nope: true } }),
    );
    expect(await store.get("profile-0003")).toBeNull();
  });

  it("lists and clears credential ids", async () => {
    const store = createCredentialStore(createMemoryStorage());
    await store.set("profile-0004", { username: "a", password: "b" });
    await store.set("profile-0005", { username: "c", password: "d" });

    expect((await store.listProfileIds()).sort()).toEqual(["profile-0004", "profile-0005"]);

    await store.clear();
    expect(await store.listProfileIds()).toEqual([]);
    expect(await store.get("profile-0004")).toBeNull();
  });

  it("keeps secrets out of persisted profile data", async () => {
    const localArea = createMemoryStorage();
    const sessionArea = createMemoryStorage();
    const profiles = createProfileStore(localArea);
    const credentials = createCredentialStore(sessionArea);

    const profile = makeProfile({
      id: "profile-0006",
      proxy: {
        type: "http",
        host: "127.0.0.1",
        port: 8080,
        username: "user",
        proxyDNS: false,
        bypassHosts: ["localhost"],
      },
    });

    await profiles.save({
      schemaVersion: SCHEMA_VERSION,
      activeProfileId: profile.id,
      profiles: [profile],
    });
    await credentials.set(profile.id, { username: "user", password: "hunter2-secret" });

    // The password exists only in the session area.
    expect(localArea.serialized()).not.toContain("hunter2-secret");
    expect(localArea.serialized()).not.toContain("password");
    expect(sessionArea.serialized()).toContain("hunter2-secret");

    // Removing the profile's credentials leaves the profile untouched.
    await credentials.remove(profile.id);
    const reloaded = await profiles.load();
    expect(reloaded.profiles).toHaveLength(2);
    expect(reloaded.profiles.find((p) => p.id === profile.id)?.proxy.username).toBe("user");
  });

  it("round-trips credential keys", () => {
    expect(credentialProfileIdFromKey(credentialKey("profile-0007"))).toBe("profile-0007");
    expect(credentialProfileIdFromKey("some.other.key")).toBeNull();
    expect(credentialProfileIdFromKey("ni.cred.v1.")).toBeNull();
  });
});
