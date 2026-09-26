/**
 * Message router tests.
 *
 * The router is the only way the UI and content scripts can change state, so these
 * tests focus on the two things that matter most: refusing anything that is not this
 * extension, and never letting a password reach persisted storage.
 */
import { describe, expect, it } from "vitest";
import { createMessageHandler, type SenderInfo } from "../src/background/messages";
import {
  parseIdentityResponse,
  parseMutationResponse,
  parseProfilesResponse,
  parseStateResponse,
} from "../src/shared/messages";
import { parseProfile } from "../src/profile/validation";
import { createHarness, makeProfile } from "./helpers";

const RUNTIME_ID = "net-identity@test";

function setup(options: Parameters<typeof createHarness>[0] = {}) {
  const harness = createHarness(options);
  const handler = createMessageHandler({
    profiles: harness.profileStore,
    credentials: harness.credentialStore,
    controller: harness.controller,
    runtimeId: RUNTIME_ID,
  });

  const ui: SenderInfo = {
    id: RUNTIME_ID,
    fromContentScript: false,
    url: "moz-extension://test/options/options.html",
  };
  const content: SenderInfo = {
    id: RUNTIME_ID,
    fromContentScript: true,
    url: "https://example.com/",
  };
  const foreign: SenderInfo = {
    id: "some-other-extension@example",
    fromContentScript: false,
    url: "moz-extension://other/options.html",
  };

  return { harness, handler, ui, content, foreign };
}

const PROXIED_PROFILE = makeProfile({
  id: "profile-0001",
  name: "Office",
  proxy: {
    type: "http",
    host: "127.0.0.1",
    port: 8080,
    username: "user",
    proxyDNS: false,
    bypassHosts: ["localhost"],
  },
});

describe("message router", () => {
  it("answers state:get with a parseable state", async () => {
    const { handler, ui } = setup();
    const response = parseStateResponse(await handler({ type: "state:get" }, ui));

    expect(response.ok).toBe(true);
    expect(response.ok && response.value.state.status).toBe("idle");
    expect(response.ok && response.value.state.activeProfileId).toBeNull();
  });

  it("ignores messages from other extensions", async () => {
    const { handler, foreign } = setup();
    expect(await handler({ type: "state:get" }, foreign)).toBeUndefined();
    expect(await handler({ type: "profiles:list" }, foreign)).toBeUndefined();
    expect(await handler({ type: "profiles:deactivate" }, foreign)).toBeUndefined();
    expect(await handler({ type: "content:hello" }, foreign)).toBeUndefined();
  });

  it("ignores malformed or unknown messages", async () => {
    const { handler, ui } = setup();
    expect(await handler(null, ui)).toBeUndefined();
    expect(await handler("hello", ui)).toBeUndefined();
    expect(await handler({ type: "not:a:request" }, ui)).toBeUndefined();
    expect(await handler({ type: "profiles:activate" }, ui)).toBeUndefined();
  });

  it("saves a profile while keeping the password in session storage only", async () => {
    const { handler, ui, harness } = setup();

    const raw = await handler(
      {
        type: "profiles:save",
        profile: PROXIED_PROFILE,
        credentials: { username: "user", password: "hunter2" },
      },
      ui,
    );
    const response = parseMutationResponse(raw);

    expect(response.ok && response.value.ok).toBe(true);
    expect(harness.localArea.serialized()).not.toContain("hunter2");
    expect(harness.sessionArea.serialized()).toContain("hunter2");

    const list = parseProfilesResponse(await handler({ type: "profiles:list" }, ui));
    expect(list.ok && list.value.profiles).toHaveLength(1);
    expect(list.ok && list.value.profiles[0]?.name).toBe("Office");
    expect(list.ok && list.value.credentialProfileIds).toEqual(["profile-0001"]);
    // The persisted profile keeps the username (not a secret) but never a password.
    expect(list.ok && list.value.profiles[0]?.proxy.username).toBe("user");
  });

  it("leaves stored credentials untouched when the password field is blank", async () => {
    const { handler, ui, harness } = setup();
    await handler(
      {
        type: "profiles:save",
        profile: PROXIED_PROFILE,
        credentials: { username: "user", password: "hunter2" },
      },
      ui,
    );
    await handler({ type: "profiles:save", profile: PROXIED_PROFILE }, ui);

    expect(await harness.credentialStore.get("profile-0001")).toEqual({
      username: "user",
      password: "hunter2",
    });
  });

  it("clears stored credentials when asked", async () => {
    const { handler, ui, harness } = setup();
    await handler(
      {
        type: "profiles:save",
        profile: PROXIED_PROFILE,
        credentials: { username: "user", password: "hunter2" },
      },
      ui,
    );
    const raw = await handler(
      { type: "profiles:save", profile: PROXIED_PROFILE, credentials: null },
      ui,
    );

    expect(parseMutationResponse(raw).ok).toBe(true);
    expect(await harness.credentialStore.get("profile-0001")).toBeNull();
    expect(harness.sessionArea.serialized()).not.toContain("hunter2");
  });

  it("rejects an invalid profile without storing anything", async () => {
    const { handler, ui, harness } = setup();
    const raw = await handler(
      {
        type: "profiles:save",
        profile: { ...PROXIED_PROFILE, proxy: { type: "http", host: "", port: 0 } },
      },
      ui,
    );
    const response = parseMutationResponse(raw);

    expect(response.ok && response.value.ok).toBe(false);
    expect(response.ok && response.value.errors.length).toBeGreaterThan(0);
    expect((await harness.profileStore.load()).profiles).toHaveLength(0);
  });

  it("activates, refreshes and deactivates", async () => {
    const { handler, ui, harness } = setup();
    await handler({ type: "profiles:save", profile: PROXIED_PROFILE }, ui);

    const activated = parseMutationResponse(
      await handler({ type: "profiles:activate", profileId: "profile-0001" }, ui),
    );
    expect(activated.ok && activated.value.ok).toBe(true);
    expect(activated.ok && activated.value.state.activeProfileId).toBe("profile-0001");
    expect(harness.providerResolveCount()).toBe(1);

    const refreshed = parseMutationResponse(await handler({ type: "identity:refresh" }, ui));
    expect(refreshed.ok && refreshed.value.state.status).toBe("ready");
    expect(harness.providerResolveCount()).toBe(2);

    const deactivated = parseMutationResponse(await handler({ type: "profiles:deactivate" }, ui));
    expect(deactivated.ok && deactivated.value.state.status).toBe("idle");
    expect(harness.controller.getTarget()).toBeNull();
  });

  it("re-activates the edited profile so changes take effect immediately", async () => {
    const { handler, ui, harness } = setup();
    await handler({ type: "profiles:save", profile: PROXIED_PROFILE }, ui);
    await handler({ type: "profiles:activate", profileId: "profile-0001" }, ui);
    expect(harness.providerResolveCount()).toBe(1);

    await handler(
      {
        type: "profiles:save",
        profile: { ...PROXIED_PROFILE, proxy: { ...PROXIED_PROFILE.proxy, port: 3128 } },
      },
      ui,
    );

    expect(harness.providerResolveCount()).toBe(2);
    expect(harness.controller.getTarget()?.proxy.port).toBe(3128);
  });

  it("reports a failed activation for an unknown profile", async () => {
    const { handler, ui } = setup();
    const response = parseMutationResponse(
      await handler({ type: "profiles:activate", profileId: "profile-9999" }, ui),
    );

    expect(response.ok && response.value.ok).toBe(false);
  });

  it("duplicates a profile without copying credentials", async () => {
    const { handler, ui, harness } = setup();
    await handler(
      {
        type: "profiles:save",
        profile: PROXIED_PROFILE,
        credentials: { username: "user", password: "hunter2" },
      },
      ui,
    );
    const raw = await handler({ type: "profiles:duplicate", profileId: "profile-0001" }, ui);

    expect(parseMutationResponse(raw).ok).toBe(true);
    const stored = await harness.profileStore.load();
    expect(stored.profiles).toHaveLength(2);
    const copy = stored.profiles.find((profile) => profile.id !== "profile-0001");
    expect(copy?.name).toBe("Office copy");
    expect(copy?.proxy).toEqual(PROXIED_PROFILE.proxy);
    expect(harness.sessionArea.serialized().match(/hunter2/g)).toHaveLength(1);
  });

  it("deletes a profile and removes its credentials", async () => {
    const { handler, ui, harness } = setup();
    await handler(
      {
        type: "profiles:save",
        profile: PROXIED_PROFILE,
        credentials: { username: "user", password: "hunter2" },
      },
      ui,
    );
    await handler({ type: "profiles:activate", profileId: "profile-0001" }, ui);

    const raw = await handler({ type: "profiles:delete", profileId: "profile-0001" }, ui);
    expect(parseMutationResponse(raw).ok).toBe(true);

    expect((await harness.profileStore.load()).profiles).toHaveLength(0);
    expect(await harness.credentialStore.get("profile-0001")).toBeNull();
    // Deleting the active profile also stops the routing.
    expect(harness.controller.getTarget()).toBeNull();
    expect(harness.sessionArea.serialized()).not.toContain("hunter2");
  });

  it("refuses to delete an unknown profile", async () => {
    const { handler, ui } = setup();
    const response = parseMutationResponse(
      await handler({ type: "profiles:delete", profileId: "profile-9999" }, ui),
    );
    expect(response.ok && response.value.ok).toBe(false);
  });

  it("answers the content handshake only for content scripts", async () => {
    const { handler, ui, content } = setup();

    const fromContent = parseIdentityResponse(await handler({ type: "content:hello" }, content));
    expect(fromContent.ok).toBe(true);
    expect(fromContent.ok && fromContent.value.envelope.payload).toBeNull();
    expect(fromContent.ok && fromContent.value.envelope.pending).toBe(false);

    expect(await handler({ type: "content:hello" }, ui)).toBeUndefined();
  });

  it("accepts a page report only from a content script, and never trusts it", async () => {
    const { handler, ui, content } = setup();
    const report = {
      source: "net-identity/page",
      type: "applied",
      generation: 1,
      timezone: "UTC",
      hasGeolocationOverride: true,
    };

    expect(await handler({ type: "content:report", payload: report }, content)).toEqual({
      accepted: true,
    });
    expect(
      await handler(
        { type: "content:report", payload: { ...report, timezone: "Mars/Olympus" } },
        content,
      ),
    ).toEqual({
      accepted: false,
    });
    expect(await handler({ type: "content:report", payload: report }, ui)).toBeUndefined();
  });
});

describe("default profile", () => {
  it("is a valid, non-proxied profile", async () => {
    const { createDefaultProfile } = await import("../src/background/messages");
    const profile = createDefaultProfile();
    const parsed = parseProfile(profile);

    expect(parsed.ok).toBe(true);
    expect(profile.proxy.type).toBe("direct");
    expect(profile.webrtcPolicy).toBe("default");
  });
});
