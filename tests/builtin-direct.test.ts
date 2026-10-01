import { describe, expect, it } from "vitest";
import {
  BUILTIN_DIRECT_NAME,
  BUILTIN_DIRECT_PROFILE_ID,
  SCHEMA_VERSION,
  createBuiltinDirectProfile,
  isBuiltinDirectProfile,
} from "../src/profile/schema";
import { createProfileStore, removeProfile } from "../src/profile/store";
import { migrateStoredProfileState } from "../src/profile/migrate";
import { createMessageHandler, type SenderInfo } from "../src/background/messages";
import { parseMutationResponse } from "../src/shared/messages";
import { createHarness, createMemoryStorage, makeProfile, SAMPLE_GEO } from "./helpers";

const RUNTIME_ID = "net-identity@test";

function createTestHarness(options: Parameters<typeof createHarness>[0] = {}) {
  const harness = createHarness(options);
  const handler = createMessageHandler({
    profiles: harness.profileStore,
    credentials: harness.credentialStore,
    controller: harness.controller,
    runtimeId: RUNTIME_ID,
  });
  const uiSender: SenderInfo = {
    id: RUNTIME_ID,
    fromContentScript: false,
    url: "moz-extension://test/popup/popup.html",
  };
  return { harness, handler, uiSender };
}

describe("built-in Direct route", () => {
  it("always exists on a fresh install and is idle without network traffic", async () => {
    const memory = createMemoryStorage();
    const store = createProfileStore(memory);
    const state = await store.load();

    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0]?.id).toBe(BUILTIN_DIRECT_PROFILE_ID);
    expect(isBuiltinDirectProfile(BUILTIN_DIRECT_PROFILE_ID)).toBe(true);
    expect(isBuiltinDirectProfile("other-profile")).toBe(false);
    expect(state.profiles[0]?.name).toBe(BUILTIN_DIRECT_NAME);
    expect(state.profiles[0]?.proxy.type).toBe("direct");
    expect(state.profiles[0]?.webrtcPolicy).toBe("default");
    expect(state.profiles[0]?.identity.mode).toBe("auto");
    expect(state.activeProfileId).toBeNull();

    // Harness initialization with this fresh store
    const harness = createHarness({ localArea: memory });
    const runtimeState = await harness.controller.initialize();

    expect(runtimeState.status).toBe("idle");
    expect(runtimeState.activeProfileId).toBeNull();
    // No GeoIP lookup triggered on startup
    expect(harness.providerResolveCount()).toBe(0);
  });

  it("migrates existing stored profiles safely and prepends Direct at index 0", () => {
    const custom1 = makeProfile({ id: "custom-proxy-1", name: "Custom Proxy 1" });
    const custom2 = makeProfile({ id: "custom-proxy-2", name: "Custom Proxy 2" });
    const stored = {
      schemaVersion: 1,
      activeProfileId: custom1.id,
      profiles: [custom1, custom2],
    };

    const migration = migrateStoredProfileState(stored);
    expect(migration.status).toBe("ready");
    if (migration.status !== "ready") return;

    expect(migration.state.profiles).toHaveLength(3);
    expect(migration.state.profiles[0]?.id).toBe(BUILTIN_DIRECT_PROFILE_ID);
    expect(migration.state.profiles[0]?.name).toBe(BUILTIN_DIRECT_NAME);
    expect(migration.state.profiles[1]?.id).toBe("custom-proxy-1");
    expect(migration.state.profiles[2]?.id).toBe("custom-proxy-2");
    expect(migration.state.activeProfileId).toBe("custom-proxy-1");
  });

  it("is idempotent and does not duplicate Direct if already present", () => {
    const direct = createBuiltinDirectProfile();
    const custom = makeProfile({ id: "custom-proxy-3", name: "Custom Proxy 3" });
    const stored = {
      schemaVersion: 1,
      activeProfileId: null,
      appliedSelection: null,
      profiles: [direct, custom],
    };

    const migration = migrateStoredProfileState(stored);
    expect(migration.status).toBe("ready");
    if (migration.status !== "ready") return;

    expect(migration.state.profiles).toHaveLength(2);
    expect(migration.state.profiles[0]?.id).toBe(BUILTIN_DIRECT_PROFILE_ID);
    expect(migration.state.profiles[1]?.id).toBe("custom-proxy-3");
  });

  it("cannot be deleted via store.removeProfile or profiles:delete", async () => {
    const state = {
      schemaVersion: SCHEMA_VERSION as typeof SCHEMA_VERSION,
      activeProfileId: null,
      appliedSelection: null,
      profiles: [createBuiltinDirectProfile(), makeProfile({ id: "p1" })],
    };
    const updated = removeProfile(state, BUILTIN_DIRECT_PROFILE_ID);
    expect(updated.profiles).toHaveLength(2);
    expect(updated.profiles[0]?.id).toBe(BUILTIN_DIRECT_PROFILE_ID);

    const { handler, uiSender } = createTestHarness();
    const response = parseMutationResponse(
      await handler({ type: "profiles:delete", profileId: BUILTIN_DIRECT_PROFILE_ID }, uiSender),
    );
    expect(response.ok && response.value.ok).toBe(false);
    expect(response.ok && response.value.errors[0]).toContain("cannot be deleted");
  });

  it("cannot be duplicated via profiles:duplicate", async () => {
    const { handler, uiSender } = createTestHarness();
    const response = parseMutationResponse(
      await handler({ type: "profiles:duplicate", profileId: BUILTIN_DIRECT_PROFILE_ID }, uiSender),
    );
    expect(response.ok && response.value.ok).toBe(false);
    expect(response.ok && response.value.errors[0]).toContain("cannot be duplicated");
  });

  it("is read-only and rejects modification via profiles:save", async () => {
    const { handler, uiSender } = createTestHarness();
    const response = parseMutationResponse(
      await handler(
        {
          type: "profiles:save",
          profile: {
            id: BUILTIN_DIRECT_PROFILE_ID,
            name: "Hacked Direct",
            proxy: { type: "http", host: "1.2.3.4", port: 8080, proxyDNS: false, bypassHosts: [] },
            identity: {
              mode: "manual",
              latitude: 10,
              longitude: 10,
              accuracy: 100,
              timezone: "UTC",
            },
            webrtcPolicy: "proxy_only",
          },
        },
        uiSender,
      ),
    );
    expect(response.ok && response.value.ok).toBe(false);
    expect(response.ok && response.value.errors[0]).toContain("read-only");
  });

  it("respects personal-data consent before querying GeoIP on Direct", async () => {
    // 1. Without consent: activation records consent_required and does not call GeoIP
    const noConsentHarness = createHarness({
      readDataCollection: async () => ({ apiAvailable: true, optionalGranted: [] }),
    });
    const stateNoConsent = await noConsentHarness.controller.activate(BUILTIN_DIRECT_PROFILE_ID);
    expect(stateNoConsent.status).toBe("ready");
    expect(stateNoConsent.lastError?.code).toBe("consent_required");
    expect(noConsentHarness.providerResolveCount()).toBe(0);

    // 2. With consent: activation resolves public IP
    const withConsentHarness = createHarness({
      readDataCollection: async () => ({
        apiAvailable: true,
        optionalGranted: ["personallyIdentifyingInfo"],
      }),
    });
    const stateWithConsent =
      await withConsentHarness.controller.activate(BUILTIN_DIRECT_PROFILE_ID);
    expect(stateWithConsent.status).toBe("ready");
    expect(stateWithConsent.identity.publicIp).toBe(SAMPLE_GEO.ip);
    expect(stateWithConsent.webrtc.desired).toBe("default");
    expect(withConsentHarness.providerResolveCount()).toBe(1);
  });

  it("handles Direct <-> Proxy switching with one click", async () => {
    const { harness, handler, uiSender } = createTestHarness();
    const proxyProfile = makeProfile({ id: "proxy-profile-1", name: "My Proxy" });
    await harness.saveProfile(proxyProfile);

    // 1. Activate Direct
    const actDirect = parseMutationResponse(
      await handler({ type: "profiles:activate", profileId: BUILTIN_DIRECT_PROFILE_ID }, uiSender),
    );
    expect(actDirect.ok && actDirect.value.ok).toBe(true);
    expect(actDirect.ok && actDirect.value.state.activeProfileId).toBe(BUILTIN_DIRECT_PROFILE_ID);
    expect(actDirect.ok && actDirect.value.state.proxy.type).toBe("direct");
    expect(harness.controller.getTarget()?.proxy.type).toBe("direct");
    expect(harness.webrtcSetting.stored.value).toBe("default");

    // 2. Switch to Proxy
    const actProxy = parseMutationResponse(
      await handler({ type: "profiles:activate", profileId: proxyProfile.id }, uiSender),
    );
    expect(actProxy.ok && actProxy.value.ok).toBe(true);
    expect(actProxy.ok && actProxy.value.state.activeProfileId).toBe(proxyProfile.id);
    expect(actProxy.ok && actProxy.value.state.proxy.type).toBe("http");
    expect(harness.controller.getTarget()?.proxy.type).toBe("http");
    expect(harness.webrtcSetting.stored.value).toBe("disable_non_proxied_udp");

    // 3. Switch back to Direct
    const actDirectAgain = parseMutationResponse(
      await handler({ type: "profiles:activate", profileId: BUILTIN_DIRECT_PROFILE_ID }, uiSender),
    );
    expect(actDirectAgain.ok && actDirectAgain.value.ok).toBe(true);
    expect(actDirectAgain.ok && actDirectAgain.value.state.activeProfileId).toBe(
      BUILTIN_DIRECT_PROFILE_ID,
    );
    expect(actDirectAgain.ok && actDirectAgain.value.state.proxy.type).toBe("direct");
    expect(harness.controller.getTarget()?.proxy.type).toBe("direct");
    expect(harness.webrtcSetting.stored.value).toBe("default");
  });

  it("handles Off <-> Direct <-> Proxy transitions cleanly", async () => {
    const { harness, handler, uiSender } = createTestHarness();
    const proxyProfile = makeProfile({ id: "proxy-profile-2", name: "Lab Proxy" });
    await harness.saveProfile(proxyProfile);

    // Initially Inactive (Off)
    const initialState = await harness.controller.initialize();
    expect(initialState.status).toBe("idle");
    expect(initialState.activeProfileId).toBeNull();
    expect(harness.controller.getTarget()).toBeNull();

    // Activate Direct
    await handler({ type: "profiles:activate", profileId: BUILTIN_DIRECT_PROFILE_ID }, uiSender);
    expect(harness.controller.getState().status).toBe("ready");
    expect(harness.controller.getState().activeProfileId).toBe(BUILTIN_DIRECT_PROFILE_ID);

    // Turn Off / Deactivate
    const deact1 = parseMutationResponse(await handler({ type: "profiles:deactivate" }, uiSender));
    expect(deact1.ok && deact1.value.ok).toBe(true);
    expect(deact1.ok && deact1.value.state.status).toBe("idle");
    expect(deact1.ok && deact1.value.state.activeProfileId).toBeNull();
    expect(harness.controller.getTarget()).toBeNull();

    // Activate Proxy
    await handler({ type: "profiles:activate", profileId: proxyProfile.id }, uiSender);
    expect(harness.controller.getState().status).toBe("ready");
    expect(harness.controller.getState().activeProfileId).toBe(proxyProfile.id);

    // Turn Off / Deactivate
    const deact2 = parseMutationResponse(await handler({ type: "profiles:deactivate" }, uiSender));
    expect(deact2.ok && deact2.value.ok).toBe(true);
    expect(deact2.ok && deact2.value.state.status).toBe("idle");
    expect(deact2.ok && deact2.value.state.activeProfileId).toBeNull();
    expect(harness.controller.getTarget()).toBeNull();
  });
});
