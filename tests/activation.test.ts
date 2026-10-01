/**
 * Activation lifecycle tests.
 *
 * These cover the guarantees that make the extension trustworthy: identity comes
 * from the observed egress IP, a slow response from an older activation can never
 * overwrite a newer one, credentials stay in session storage, routing survives a
 * background restart, and deactivation really stops the spoofing.
 */
import { describe, expect, it } from "vitest";
import { BRIDGE_SOURCE, GEOIP_ACCURACY_METERS, PAGE_SOURCE } from "../src/shared/constants";
import type { GeoIpResult } from "../src/geo/provider";
import {
  SAMPLE_GEO,
  createDeferred,
  createFailingProvider,
  createHarness,
  createMemoryStorage,
  createScriptedProvider,
  makeProfile,
  waitUntil,
} from "./helpers";

const BERLIN_GEO: GeoIpResult = {
  ip: "198.51.100.9",
  countryCode: "DE",
  region: "Berlin",
  city: "Berlin",
  latitude: 52.52,
  longitude: 13.405,
  timezone: "Europe/Berlin",
};

function checkStatus(harness: ReturnType<typeof createHarness>, id: string): string | undefined {
  return harness.controller.getState().audit.checks.find((check) => check.id === id)?.status;
}

function terminalProxy(
  decision: browser.proxy.ProxyInfo | Array<browser.proxy.ProxyInfo | null>,
): browser.proxy.ProxyInfo {
  expect(Array.isArray(decision)).toBe(true);
  if (!Array.isArray(decision)) throw new Error("expected a terminal proxy list");
  expect(decision[1]).toBeNull();
  expect(decision[0]?.failoverTimeout).toBe(1);
  if (decision[0] === null || decision[0] === undefined) throw new Error("proxy is missing");
  return decision[0];
}

describe("activation", () => {
  it("activates a profile atomically and publishes the observed identity", async () => {
    const harness = createHarness({
      // Simulate an open tab whose shim already applied the new identity, which is
      // what makes the audit report a fully consistent state.
      probeContent: async (generation) => ({
        activeTabId: 1,
        frames: [{ tabId: 1, frameId: 0, generation, timezone: "Europe/Amsterdam", updatedAt: 1 }],
      }),
    });
    const profile = makeProfile({ id: "profile-0001", name: "Amsterdam" });
    await harness.saveProfile(profile);

    const state = await harness.controller.activate(profile.id);

    expect(state.status).toBe("ready");
    expect(state.activeProfileId).toBe(profile.id);
    expect(state.activeProfileName).toBe("Amsterdam");

    // Identity comes from the provider (the observed egress address), never from the
    // proxy hostname.
    expect(state.identity.source).toBe("auto");
    expect(state.identity.publicIp).toBe(SAMPLE_GEO.ip);
    expect(state.identity.observedIp).toBe(SAMPLE_GEO.ip);
    expect(state.identity.publicIpVerified).toBe(true);
    expect(state.identity.city).toBe("Amsterdam");
    expect(state.identity.timezone).toBe("Europe/Amsterdam");
    expect(state.identity.accuracy).toBe(GEOIP_ACCURACY_METERS);

    expect(state.audit.verdict).toBe("consistent");
    expect(state.proxy.configured).toBe(true);
    expect(state.proxy.hasCredentials).toBe(false);

    // Routing is live, WebRTC is applied, and the profile pointer is persisted.
    expect(harness.controller.getTarget()?.profileId).toBe(profile.id);
    expect(harness.webrtcSetting.stored.value).toBe("disable_non_proxied_udp");
    expect(await harness.storedActiveProfileId()).toBe(profile.id);

    // The session snapshot exists (so a background restart can restore routing) and
    // the local area never contains the identity target.
    expect(harness.sessionArea.snapshot()["ni.active-target.v1"]).toBeDefined();
    expect(harness.localArea.serialized()).not.toContain("ni.active-target.v1");

    // Pages were told about the identity, and the payload is public-only.
    const lastEnvelope = harness.envelopes.at(-1);
    expect(lastEnvelope?.payload?.generation).toBe(state.generation);
    expect(lastEnvelope?.payload?.timezone).toBe("Europe/Amsterdam");
    expect(JSON.stringify(harness.envelopes)).not.toMatch(/password|username|authorization/i);
  });

  it("keeps the proxy password in session storage only", async () => {
    const harness = createHarness();
    const profile = makeProfile({
      id: "profile-0002",
      proxy: {
        type: "http",
        host: "127.0.0.1",
        port: 8080,
        authenticationRequired: true,
        proxyDNS: false,
        bypassHosts: ["localhost"],
      },
    });
    await harness.saveProfile(profile);
    await harness.credentialStore.set(profile.id, { username: "user", password: "hunter2" });

    const state = await harness.controller.activate(profile.id);

    expect(state.proxy.hasCredentials).toBe(true);
    expect(harness.localArea.serialized()).not.toContain("hunter2");
    expect(harness.sessionArea.serialized()).toContain("hunter2");
    expect(JSON.stringify(harness.envelopes)).not.toContain("hunter2");

    // The credential does reach Firefox's proxy decision, where it is needed.
    const decision = terminalProxy(
      await harness.controller.decideProxyForRequest("https://example.com/"),
    );
    expect(decision.proxyAuthorizationHeader).toBeDefined();
    expect(decision.proxyAuthorizationHeader).toContain("Basic ");
  });

  it("discards a stale identity response from an older activation", async () => {
    const slowResponse = createDeferred<GeoIpResult>();
    let resolveCount = 0;
    let firstSignal: AbortSignal | undefined;

    const provider = createScriptedProvider((signal) => {
      resolveCount += 1;
      if (resolveCount === 1) {
        firstSignal = signal;
        return slowResponse.promise;
      }
      return Promise.resolve(BERLIN_GEO);
    });

    const harness = createHarness({ provider });
    const slowProfile = makeProfile({ id: "profile-0003", name: "slow" });
    const fastProfile = makeProfile({ id: "profile-0004", name: "fast" });
    await harness.saveProfile(slowProfile);
    await harness.saveProfile(fastProfile);

    const slowActivation = harness.controller.activate(slowProfile.id);
    await waitUntil(() => resolveCount === 1);

    await harness.controller.activate(fastProfile.id);
    // Starting a new activation cancels the previous in-flight lookup.
    expect(firstSignal?.aborted).toBe(true);

    // The old lookup finally answers - and must be ignored.
    slowResponse.resolve(SAMPLE_GEO);
    await slowActivation;

    const state = harness.controller.getState();
    expect(state.activeProfileId).toBe(fastProfile.id);
    expect(state.identity.city).toBe("Berlin");
    expect(state.identity.publicIp).toBe(BERLIN_GEO.ip);
    expect(state.identity.timezone).toBe("Europe/Berlin");
    expect(harness.controller.getTarget()?.profileName).toBe("fast");
  });

  it("stays active but reports a provider failure precisely", async () => {
    const harness = createHarness({
      provider: createFailingProvider("provider unreachable", "network"),
    });
    const profile = makeProfile({ id: "profile-0005" });
    await harness.saveProfile(profile);

    const state = await harness.controller.activate(profile.id);

    expect(state.status).toBe("ready");
    expect(state.lastError?.code).toBe("provider_error");
    expect(state.audit.verdict).toBe("partial");
    expect(state.identity.publicIp).toBeUndefined();
    expect(checkStatus(harness, "public_ip")).toBe("provider_error");

    // Routing is unaffected by a failed lookup.
    const decision = terminalProxy(
      await harness.controller.decideProxyForRequest("https://example.com/"),
    );
    expect(decision.type).toBe("http");

    // The page must stay under extension control, with no coordinates to fall back on.
    const last = harness.envelopes.at(-1);
    expect(last?.controlled).toBe(true);
    expect(last?.pending).toBe(false);
    expect(last?.payload?.latitude).toBeUndefined();
    expect(harness.envelopes.every((envelope) => envelope.controlled)).toBe(true);
  });

  it("applies manual values and still records the observed egress IP", async () => {
    const harness = createHarness();
    const profile = makeProfile({
      id: "profile-0006",
      identity: {
        mode: "manual",
        latitude: 48.8566,
        longitude: 2.3522,
        accuracy: 500,
        timezone: "Europe/Paris",
      },
    });
    await harness.saveProfile(profile);

    const state = await harness.controller.activate(profile.id);

    expect(state.identity.source).toBe("manual");
    expect(state.identity.latitude).toBe(48.8566);
    expect(state.identity.longitude).toBe(2.3522);
    expect(state.identity.accuracy).toBe(500);
    expect(state.identity.timezone).toBe("Europe/Paris");
    expect(state.identity.observedIp).toBe(SAMPLE_GEO.ip);

    // Manual values are not overwritten in storage.
    const stored = await harness.profileStore.load();
    const saved = stored.profiles.find((p) => p.id === profile.id);
    expect(saved?.identity.latitude).toBe(48.8566);
    expect(saved?.identity.city).toBeUndefined();
  });

  it("persists auto-resolved values back into the profile", async () => {
    const harness = createHarness();
    const profile = makeProfile({ id: "profile-0007" });
    await harness.saveProfile(profile);

    await harness.controller.activate(profile.id);
    const stored = await harness.profileStore.load();
    const updated = stored.profiles.find((p) => p.id === profile.id);

    expect(updated?.identity.publicIp).toBe(SAMPLE_GEO.ip);
    expect(updated?.identity.timezone).toBe("Europe/Amsterdam");
    expect(updated?.identity.lastResolvedAt).toBe(harness.clock.now());
    expect(JSON.stringify(stored).toLowerCase()).not.toContain("password");
  });

  it("deactivates: clears routing, relinquishes WebRTC control and stops spoofing", async () => {
    const harness = createHarness();
    const profile = makeProfile({ id: "profile-0008" });
    await harness.saveProfile(profile);
    await harness.controller.activate(profile.id);

    const state = await harness.controller.deactivate();

    expect(state.status).toBe("idle");
    expect(state.activeProfileId).toBeNull();
    expect(harness.controller.getTarget()).toBeNull();
    expect(await harness.controller.decideProxyForRequest("https://example.com/")).toEqual({
      type: "direct",
    });
    expect(harness.webrtcSetting.clearCalls).toBe(1);
    expect(harness.webrtcSetting.stored.value).toBe(harness.webrtcSetting.baseline);
    expect(harness.sessionArea.snapshot()["ni.active-target.v1"]).toBeUndefined();
    expect(await harness.storedActiveProfileId()).toBeNull();
    // The last envelope tells pages to go back to native behaviour.
    expect(harness.envelopes.at(-1)?.payload).toBeNull();
    expect(harness.envelopes.at(-1)?.pending).toBe(false);
    expect(harness.envelopes.at(-1)?.controlled).toBe(false);
    expect(harness.envelopes.slice(0, -1).every((envelope) => envelope.controlled)).toBe(true);
  });

  it("does not let a setting refresh change state during deactivation", async () => {
    const harness = createHarness();
    const profile = makeProfile({
      id: "profile-0041",
      identity: {
        mode: "manual",
        latitude: 48.2,
        longitude: 11.4,
        accuracy: 1500,
        timezone: "Pacific/Auckland",
      },
    });
    await harness.saveProfile(profile);
    await harness.controller.activate(profile.id);

    // Hold the WebRTC release open. Firefox schedules the privacy setting's
    // `onChange` after `clear()` writes the value, so `refreshObservedSettings()`
    // can run while the target is already gone but the old identity is still in
    // `state`. The refresh must not commit that torn combination.
    const clearGate = createDeferred<boolean>();
    let clearStarted = false;
    const originalClear = harness.webrtcSetting.clear.bind(harness.webrtcSetting);
    harness.webrtcSetting.clear = async () => {
      clearStarted = true;
      await clearGate.promise;
      return originalClear({});
    };

    const deactivation = harness.controller.deactivate();
    await waitUntil(() => clearStarted);

    const duringTransition = harness.controller.getState();
    await harness.controller.refreshObservedSettings();
    // The refresh must return the current state untouched instead of publishing a
    // profile-less state that still carries the old coordinates.
    expect(harness.controller.getState()).toBe(duringTransition);

    clearGate.resolve(true);
    const state = await deactivation;

    expect(state.status).toBe("idle");
    expect(state.activeProfileId).toBeNull();
    expect(state.identity.latitude).toBeUndefined();
    expect(state.identity.timezone).toBeUndefined();
    expect(harness.controller.getEnvelope().payload).toBeNull();
  });
  it("keeps failed teardown controlled and clears the departed route's identity", async () => {
    const harness = createHarness();
    const profile = makeProfile({ id: "failed-teardown" });
    await harness.saveProfile(profile);
    await harness.controller.activate(profile.id);
    const clear = harness.targetStore.clear.bind(harness.targetStore);
    harness.targetStore.clear = async () => {
      throw new Error("session write failed");
    };
    const state = await harness.controller.deactivate();
    expect(state.status).toBe("error");
    expect(state.activeProfileId).toBe(profile.id);
    expect(state.identity.latitude).toBeUndefined();
    expect(state.identity.timezone).toBeUndefined();
    expect(harness.controller.getEnvelope()).toMatchObject({ payload: null, controlled: true });
    expect(harness.envelopes.at(-1)?.controlled).toBe(true);
    harness.targetStore.clear = clear;
    await harness.controller.deactivate();
    expect(harness.controller.getEnvelope().controlled).toBe(false);
  });
  it("does not attach the previous identity when a switched route fails to persist", async () => {
    const harness = createHarness();
    await harness.saveProfile(makeProfile({ id: "previous-route" }));
    await harness.controller.activate("previous-route");
    harness.targetStore.save = async () => {
      throw new Error("session write failed");
    };
    const state = await harness.controller.activate("builtin-direct");
    expect(state.status).toBe("error");
    expect(state.activeProfileId).toBe("builtin-direct");
    expect(state.identity.latitude).toBeUndefined();
    expect(state.identity.timezone).toBeUndefined();
    expect(harness.controller.getEnvelope()).toMatchObject({ controlled: true, payload: null });
  });

  it("never publishes identity coordinates while no profile is active", async () => {
    const harness = createHarness();
    const profile = makeProfile({
      id: "profile-0042",
      identity: {
        mode: "manual",
        latitude: 48.2,
        longitude: 11.4,
        accuracy: 1500,
        timezone: "Pacific/Auckland",
      },
    });
    await harness.saveProfile(profile);
    await harness.controller.activate(profile.id);

    // A proxy error arriving during teardown composes a state with no active
    // profile but the previous coordinates. Pages must never receive them.
    const clearGate = createDeferred<boolean>();
    let clearStarted = false;
    const originalClear = harness.webrtcSetting.clear.bind(harness.webrtcSetting);
    harness.webrtcSetting.clear = async () => {
      clearStarted = true;
      await clearGate.promise;
      return originalClear({});
    };

    const deactivation = harness.controller.deactivate();
    await waitUntil(() => clearStarted);
    void harness.controller.recordProxyError(new Error("boom"));
    await waitUntil(() => harness.controller.getState().lastError?.code === "proxy_error");

    expect(harness.controller.getState().activeProfileId).toBeNull();
    expect(harness.controller.getEnvelope().payload).toBeNull();

    clearGate.resolve(true);
    await deactivation;
  });

  it("reports an error state instead of throwing when the profile is unknown", async () => {
    const harness = createHarness();
    const state = await harness.controller.activate("profile-9999");

    expect(state.status).toBe("error");
    expect(state.lastError?.code).toBe("profile_missing");
    expect(harness.controller.getTarget()).toBeNull();
  });

  it("refreshes the active identity on demand", async () => {
    const harness = createHarness({ provider: createScriptedProvider(async () => SAMPLE_GEO) });
    const profile = makeProfile({ id: "profile-0009" });
    await harness.saveProfile(profile);
    await harness.controller.activate(profile.id);

    harness.setProvider(createScriptedProvider(async () => BERLIN_GEO));
    const state = await harness.controller.refresh();

    expect(state.identity.publicIp).toBe(BERLIN_GEO.ip);
    expect(state.identity.timezone).toBe("Europe/Berlin");
    expect(harness.providerResolveCount()).toBe(2);
  });

  it("reports a content-shim generation mismatch as stale", async () => {
    const harness = createHarness();
    const profile = makeProfile({ id: "profile-0010" });
    await harness.saveProfile(profile);
    const state = await harness.controller.activate(profile.id);

    harness.controller.recordContentReport(
      {
        source: PAGE_SOURCE,
        type: "applied",
        generation: state.generation - 1,
        timezone: "Europe/Amsterdam",
        hasGeolocationOverride: true,
      },
      { tabId: 1, frameId: 0 },
    );

    await waitUntil(() => harness.controller.getState().content.reportedGeneration !== null);
    expect(checkStatus(harness, "content_shim")).toBe("stale");
  });

  it("marks the page shim as current when generation and timezone agree", async () => {
    const harness = createHarness({
      probeContent: async (generation) => ({
        activeTabId: 1,
        frames: [{ tabId: 1, frameId: 0, generation, timezone: "Europe/Amsterdam", updatedAt: 1 }],
      }),
    });
    const profile = makeProfile({ id: "profile-0011" });
    await harness.saveProfile(profile);

    const state = await harness.controller.activate(profile.id);

    expect(state.content.hasShim).toBe(true);
    expect(state.content.reportedGeneration).toBe(state.generation);
    expect(state.content.frameCount).toBe(1);
    expect(state.content.currentFrameCount).toBe(1);
    expect(checkStatus(harness, "content_shim")).toBe("ok");
  });

  it("does not call the audit consistent when another frame is stale", async () => {
    const harness = createHarness({
      probeContent: async (generation) => ({
        activeTabId: 1,
        frames: [{ tabId: 1, frameId: 0, generation, timezone: "Europe/Amsterdam", updatedAt: 2 }],
      }),
    });
    const profile = makeProfile({ id: "profile-0012" });
    await harness.saveProfile(profile);
    const state = await harness.controller.activate(profile.id);

    harness.controller.recordContentReport(
      {
        source: PAGE_SOURCE,
        type: "applied",
        generation: state.generation - 1,
        timezone: "Europe/Amsterdam",
        hasGeolocationOverride: true,
      },
      { tabId: 2, frameId: 0 },
    );

    await waitUntil(() => harness.controller.getState().content.frameCount === 2);
    const latest = harness.controller.getState();
    expect(latest.content.currentFrameCount).toBe(1);
    expect(latest.content.activeTabCurrent).toBe(true);
    expect(checkStatus(harness, "content_shim")).toBe("stale");
    expect(latest.audit.verdict).not.toBe("consistent");

    harness.controller.forgetContentTab(2);
    await waitUntil(() => harness.controller.getState().content.frameCount === 1);
    expect(checkStatus(harness, "content_shim")).toBe("ok");
  });

  it("updates the audit when Firefox proxy or WebRTC control changes later", async () => {
    const firefoxProxy = {
      proxyType: "none",
      levelOfControl: "controllable_by_this_extension",
    };
    const harness = createHarness({ firefoxProxy });
    const profile = makeProfile({ id: "profile-0013" });
    await harness.saveProfile(profile);
    const activated = await harness.controller.activate(profile.id);
    const providerCalls = harness.providerResolveCount();
    const setCalls = harness.webrtcSetting.setCalls;

    firefoxProxy.proxyType = "manual";
    const proxyChanged = await harness.controller.refreshObservedSettings();
    expect(checkStatus(harness, "firefox_proxy")).toBe("unavailable");
    expect(proxyChanged.generation).toBe(activated.generation);
    expect(harness.providerResolveCount()).toBe(providerCalls);
    expect(harness.webrtcSetting.setCalls).toBe(setCalls);
    expect(harness.controller.getTarget()?.proxy.type).toBe("http");

    harness.webrtcSetting.stored.value = "default";
    harness.webrtcSetting.stored.levelOfControl = "controlled_by_other_extensions";
    const webrtcChanged = await harness.controller.refreshObservedSettings();
    expect(checkStatus(harness, "webrtc")).toBe("controlled_by_other_extension");
    expect(webrtcChanged.generation).toBe(activated.generation);
    expect(harness.webrtcSetting.setCalls).toBe(setCalls);
  });

  it("surfaces proxy errors without leaking credentials", async () => {
    const harness = createHarness();
    const profile = makeProfile({ id: "profile-0012" });
    await harness.saveProfile(profile);
    await harness.controller.activate(profile.id);

    void harness.controller.recordProxyError(new Error("Proxy-Authorization: Basic dXNlcjpwdw=="));
    await waitUntil(() => harness.controller.getState().lastError?.code === "proxy_error");

    const message = harness.controller.getState().lastError?.message ?? "";
    expect(message).not.toContain("dXNlcjpwdw==");
    expect(message).not.toContain("Basic");
  });

  it("does not let an in-flight proxy diagnostic erase a newly resolved identity", async () => {
    const provider = createDeferred<GeoIpResult>();
    const diagnosticStarted = createDeferred<void>();
    const releaseDiagnostic = createDeferred<void>();
    const h = createHarness({ provider: createScriptedProvider(() => provider.promise) });
    const readSettings = h.deps.readFirefoxProxySettings;
    let holdNextRead = false;
    h.deps.readFirefoxProxySettings = async () => {
      if (holdNextRead) {
        holdNextRead = false;
        diagnosticStarted.resolve();
        await releaseDiagnostic.promise;
      }
      return readSettings();
    };
    const profile = makeProfile({ id: "diagnostic-race" });
    await h.saveProfile(profile);
    const activation = h.controller.activate(profile.id);
    await waitUntil(() => h.providerResolveCount() === 1);
    holdNextRead = true;
    const diagnostic = h.controller.recordProxyError(new Error("proxy reported a transient error"));
    await diagnosticStarted.promise;
    provider.resolve(SAMPLE_GEO);
    await activation;
    releaseDiagnostic.resolve();
    await diagnostic;
    expect(h.controller.getState().identity.timezone).toBe("Europe/Amsterdam");
    expect(h.controller.getEnvelope().payload?.timezone).toBe("Europe/Amsterdam");
  });
});

describe("background restart", () => {
  it("ignores a stale session snapshot after a newer Apply of the same profile", async () => {
    const h = createHarness();
    const first = makeProfile({ id: "same-profile", revision: 1 });
    await h.saveProfile(first);
    await h.controller.activate(first.id);
    const oldSnapshot = h.sessionArea.snapshot()["ni.active-target.v1"];

    const second = makeProfile({
      id: first.id,
      revision: 2,
      proxy: { type: "http", host: "127.0.0.1", port: 9090, proxyDNS: false, bypassHosts: [] },
    });
    await h.saveProfile(second);
    await h.controller.activate(second.id);
    await h.sessionArea.set({ "ni.active-target.v1": oldSnapshot });

    const revived = createHarness({ localArea: h.localArea, sessionArea: h.sessionArea });
    const firstRequest = terminalProxy(
      await revived.controller.decideProxyForRequest("https://example.invalid/"),
    );
    expect(firstRequest.port).toBe(9090);
    const state = await revived.controller.initialize();
    expect(state.activeProfileId).toBe(first.id);
    expect(revived.controller.getTarget()?.proxy.port).toBe(9090);
  });

  it("restores routing and identity from the session snapshot without a new lookup", async () => {
    const harness = createHarness();
    const profile = makeProfile({ id: "profile-0020", name: "Airport" });
    await harness.saveProfile(profile);
    await harness.controller.activate(profile.id);

    // A new background page sharing the same storage areas: this is what Firefox
    // does when it suspends and later revives an event page.
    const restarted = createHarness({
      localArea: harness.localArea,
      sessionArea: harness.sessionArea,
      provider: createFailingProvider("the provider must not be called", "network"),
    });

    const state = await restarted.controller.initialize();

    expect(state.status).toBe("ready");
    expect(state.activeProfileId).toBe(profile.id);
    expect(state.identity.publicIp).toBe(SAMPLE_GEO.ip);
    expect(state.identity.timezone).toBe("Europe/Amsterdam");
    expect(restarted.providerResolveCount()).toBe(0);
    expect(restarted.controller.getTarget()?.profileId).toBe(profile.id);
  });

  it("never falls back to a direct connection while restoring", async () => {
    const harness = createHarness();
    const profile = makeProfile({ id: "profile-0021" });
    await harness.saveProfile(profile);
    await harness.controller.activate(profile.id);

    const restarted = createHarness({
      localArea: harness.localArea,
      sessionArea: harness.sessionArea,
    });

    // No initialize() call yet: the first proxy decision must still be proxied.
    const decision = terminalProxy(
      await restarted.controller.decideProxyForRequest("https://example.com/"),
    );
    expect(decision.type).toBe("http");
    expect(decision.host).toBe("127.0.0.1");

    // WebSocket traffic uses the same restored route. A loopback bypass still applies.
    const websocket = terminalProxy(
      await restarted.controller.decideProxyForRequest("wss://example.com/socket"),
    );
    expect(websocket.type).toBe("http");
    expect(websocket.host).toBe("127.0.0.1");
    expect(await restarted.controller.decideProxyForRequest("ws://localhost/socket")).toEqual({
      type: "direct",
    });
    expect(await restarted.controller.decideProxyForRequest("http://localhost:3000/")).toEqual({
      type: "direct",
    });
  });

  it("keeps geolocation controlled until startup has settled", () => {
    const harness = createHarness();
    expect(harness.controller.getEnvelope()).toEqual({
      source: BRIDGE_SOURCE,
      type: "identity",
      payload: null,
      pending: true,
      controlled: true,
    });
  });

  it("does not release geolocation when startup observes an empty store too late", async () => {
    const harness = createHarness();
    let releaseRead: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let parked = false;
    const originalLoad = harness.profileStore.load.bind(harness.profileStore);
    harness.profileStore.load = async () => {
      if (!parked) {
        const snapshot = await originalLoad();
        parked = true;
        await gate;
        return snapshot;
      }
      return originalLoad();
    };

    const startup = harness.controller.initialize();
    await waitUntil(() => parked);

    const profile = makeProfile({ id: "profile-0099" });
    await harness.saveProfile(profile);
    await harness.controller.activate(profile.id);
    releaseRead();
    await startup;

    expect(harness.controller.getState().activeProfileId).toBe(profile.id);
    expect(harness.controller.getState().status).toBe("ready");
    const last = harness.envelopes.at(-1);
    expect(last?.controlled).toBe(true);
    expect(last?.payload?.latitude).toBe(SAMPLE_GEO.latitude);
  });

  it("is direct when there is no session snapshot", async () => {
    const harness = createHarness();
    expect(await harness.controller.decideProxyForRequest("https://example.com/")).toEqual({
      type: "direct",
    });
    expect(await harness.controller.decideProxyForRequest("wss://example.com/socket")).toEqual({
      type: "direct",
    });
  });

  it("does not need a session snapshot for Off, then activates and deactivates", async () => {
    const harness = createHarness();
    let reads = 0;
    const originalLoad = harness.targetStore.load.bind(harness.targetStore);
    harness.targetStore.load = async () => {
      reads += 1;
      return originalLoad();
    };

    expect(await harness.controller.decideProxyForRequest("https://example.com/")).toEqual({
      type: "direct",
    });
    expect(await harness.controller.decideProxyForRequest("https://example.com/again")).toEqual({
      type: "direct",
    });
    expect(reads).toBe(0);

    const profile = makeProfile({ id: "profile-0023" });
    await harness.saveProfile(profile);
    await harness.controller.activate(profile.id);
    const active = terminalProxy(
      await harness.controller.decideProxyForRequest("https://example.com/"),
    );
    expect(active.type).toBe("http");
    expect(active.host).toBe("127.0.0.1");

    await harness.controller.deactivate();
    const readsAfterDeactivate = reads;
    expect(await harness.controller.decideProxyForRequest("https://example.com/")).toEqual({
      type: "direct",
    });
    expect(await harness.controller.decideProxyForRequest("https://example.com/later")).toEqual({
      type: "direct",
    });
    expect(reads).toBe(readsAfterDeactivate);
  });

  it("restores an active snapshot once and reuses it for later requests", async () => {
    const harness = createHarness();
    const profile = makeProfile({ id: "profile-0024" });
    await harness.saveProfile(profile);
    await harness.controller.activate(profile.id);

    const restarted = createHarness({
      localArea: harness.localArea,
      sessionArea: harness.sessionArea,
    });
    let reads = 0;
    const originalLoad = restarted.targetStore.load.bind(restarted.targetStore);
    restarted.targetStore.load = async () => {
      reads += 1;
      return originalLoad();
    };

    const first = terminalProxy(
      await restarted.controller.decideProxyForRequest("https://example.com/"),
    );
    const second = terminalProxy(
      await restarted.controller.decideProxyForRequest("https://example.org/"),
    );
    expect(first.type).toBe("http");
    expect(second.type).toBe("http");
    expect(second.host).toBe("127.0.0.1");
    expect(reads).toBe(1);
  });

  it("performs a full activation on a fresh browser session", async () => {
    const first = createHarness();
    const profile = makeProfile({ id: "profile-0022" });
    await first.saveProfile(profile);
    await first.controller.activate(profile.id);

    // A new browser session: local storage persists, session storage does not.
    const freshSession = createHarness({ localArea: first.localArea });
    const state = await freshSession.controller.initialize();

    expect(state.status).toBe("ready");
    expect(state.activeProfileId).toBe(profile.id);
    expect(freshSession.providerResolveCount()).toBe(1);
  });

  it("routes through the durable proxy before initialize when session storage is empty", async () => {
    const first = createHarness();
    const profile = makeProfile({ id: "durable-startup" });
    await first.saveProfile(profile);
    await first.controller.activate(profile.id);

    const fresh = createHarness({ localArea: first.localArea });
    const [http, https, ws, wss] = await Promise.all([
      fresh.controller.decideProxyForRequest("http://example.invalid/"),
      fresh.controller.decideProxyForRequest("https://example.invalid/"),
      fresh.controller.decideProxyForRequest("ws://example.invalid/"),
      fresh.controller.decideProxyForRequest("wss://example.invalid/"),
    ]);
    for (const decision of [http, https, ws, wss]) {
      const proxy = terminalProxy(decision);
      expect(proxy.type).toBe("http");
      expect(proxy.host).toBe(profile.proxy.host);
    }
    expect(await fresh.controller.shouldBlockRequest("https://example.invalid/")).toBe(false);
    expect(fresh.providerResolveCount()).toBe(0);
  });

  it("keeps the applied proxy after Save changes its configuration and Firefox loses session storage", async () => {
    const first = createHarness();
    const profile = makeProfile({ id: "saved-but-not-applied" });
    await first.saveProfile(profile);
    await first.controller.activate(profile.id);
    await first.saveProfile({
      ...profile,
      revision: 2,
      proxy: { type: "direct", proxyDNS: false, bypassHosts: [] },
    });
    const fresh = createHarness({ localArea: first.localArea });
    const routed = terminalProxy(
      await fresh.controller.decideProxyForRequest("https://example.invalid/"),
    );
    expect(routed.type).toBe("http");
    expect(routed.host).toBe(profile.proxy.host);
    expect((await fresh.controller.initialize()).activeProfileId).toBe(profile.id);
  });

  it("blocks malformed durable routing state instead of treating it as Off", async () => {
    const localArea = createMemoryStorage({
      "ni.state.v1": { schemaVersion: 2, profiles: [], activeProfileId: "missing" },
    });
    const fresh = createHarness({ localArea });
    expect(await fresh.controller.shouldBlockRequest("https://example.invalid/")).toBe(true);
    expect(await fresh.controller.shouldBlockRequest("wss://example.invalid/")).toBe(true);
    expect(await fresh.controller.shouldBlockRequest("moz-extension://test/page.html")).toBe(false);
  });

  it("blocks requests when durable storage cannot be read", async () => {
    const localArea = createMemoryStorage();
    localArea.get = async () => {
      throw new Error("storage unavailable");
    };
    const fresh = createHarness({ localArea });
    expect(await fresh.controller.shouldBlockRequest("https://example.invalid/")).toBe(true);
    expect(await fresh.controller.shouldBlockRequest("ws://example.invalid/")).toBe(true);
  });

  it("keeps an authenticated SOCKS route after the session password disappears", async () => {
    const first = createHarness();
    const profile = makeProfile({
      id: "auth-restart",
      proxy: {
        type: "socks5",
        host: "127.0.0.1",
        port: 1080,
        authenticationRequired: true,
        proxyDNS: true,
        bypassHosts: [],
      },
      identity: {
        mode: "manual",
        geoIpPolicy: "disabled",
        latitude: 0,
        longitude: 0,
        accuracy: 20000,
        timezone: "UTC",
      },
    });
    await first.saveProfile(profile);
    await first.credentialStore.set(profile.id, { username: "user", password: "test-password" });
    await first.controller.activate(profile.id);
    const fresh = createHarness({ localArea: first.localArea });
    const routed = terminalProxy(
      await fresh.controller.decideProxyForRequest("https://example.invalid/"),
    );
    expect(routed.type).toBe("socks");
    expect(routed.username).toBeUndefined();
    const state = await fresh.controller.initialize();
    expect(state.desiredRoute).toBe("proxy");
    expect(state.appliedRoute).toBe("proxy");
    expect(state.runtimeHealth).toBe("credentials_required");
    expect(state.activeProfileId).toBe(profile.id);
  });

  it("correlates suspect health, preserves identity and recovers only with sustained success", async () => {
    let now = 0;
    const harness = createHarness({ now: () => now });
    const profile = makeProfile({
      id: "health-proxy",
      proxy: { type: "socks5", host: "proxy.invalid", port: 1080, proxyDNS: true, bypassHosts: [] },
    });
    await harness.saveProfile(profile);
    const activated = await harness.controller.activate(profile.id);
    const observations = [];
    for (let i = 0; i < 6; i++) {
      const url = `https://origin${i % 2}.invalid/`;
      const requestId = `request-${i}`;
      const proxyInfo = terminalProxy(
        await harness.controller.decideProxyForRequest(url, requestId),
      );
      observations.push({
        url,
        requestId,
        proxyInfo,
        fromCache: false,
        error: "NS_ERROR_NET_RESET",
      });
    }
    for (const details of observations.slice(0, 3)) {
      harness.controller.recordNetworkFailure(details);
      now += 350;
    }
    await waitUntil(() => harness.controller.getState().runtimeHealth === "degraded");
    expect(harness.controller.getState().lastError?.code).toBe("proxy_suspect");
    expect(harness.controller.getState().desiredRoute).toBe("proxy");
    expect(harness.controller.getState().appliedRoute).toBe("proxy");
    expect(harness.controller.getState().identity).toEqual(activated.identity);
    expect(harness.controller.getState().generation).toBe(activated.generation);
    for (const details of observations.slice(3)) {
      harness.controller.recordNetworkSuccess(details);
      now += 600;
    }
    await waitUntil(() => harness.controller.getState().runtimeHealth === "healthy");
    expect(harness.controller.getState().activeProfileId).toBe(profile.id);
  });

  it("ignores stale generation, uncorrelated, bypass, cached and origin-only failures", async () => {
    let now = 0;
    const harness = createHarness({ now: () => now });
    const profile = makeProfile({
      id: "health-isolated",
      proxy: { type: "socks5", host: "proxy.invalid", port: 1080, proxyDNS: true, bypassHosts: [] },
    });
    await harness.saveProfile(profile);
    await harness.controller.activate(profile.id);
    const url = "https://example.invalid/";
    const proxyInfo = terminalProxy(await harness.controller.decideProxyForRequest(url, "old"));
    await harness.controller.activate(profile.id);
    harness.controller.recordNetworkFailure({ url, requestId: "old", proxyInfo, error: "failure" });
    for (let i = 0; i < 6; i++) {
      const requestId = `isolated-${i}`;
      await harness.controller.decideProxyForRequest(url, requestId);
      harness.controller.recordNetworkFailure({ url, requestId, proxyInfo, error: "failure" });
      now += 400;
    }
    expect(harness.controller.getState().runtimeHealth).toBe("healthy");
    expect(harness.controller.decideProxyForRequest(url)).not.toBeInstanceOf(Promise);
  });

  it("wakes cooldown on Off and recomputes the route without retaining the old proxy", async () => {
    let now = 0;
    const harness = createHarness({ now: () => now });
    const profile = makeProfile({
      id: "health-off",
      proxy: { type: "socks5", host: "proxy.invalid", port: 1080, proxyDNS: true, bypassHosts: [] },
    });
    await harness.saveProfile(profile);
    await harness.controller.activate(profile.id);
    for (let i = 0; i < 3; i++) {
      const url = `https://origin${i % 2}.invalid/`;
      const requestId = `off-${i}`;
      const proxyInfo = terminalProxy(
        await harness.controller.decideProxyForRequest(url, requestId),
      );
      harness.controller.recordNetworkFailure({ url, requestId, proxyInfo, error: "failure" });
      if (i < 2) now += 350;
    }
    const pending = harness.controller.decideProxyForRequest("https://pending.invalid/");
    expect(pending).toBeInstanceOf(Promise);
    await harness.controller.deactivate();
    // A wake during teardown may retain the departing mandatory route until Off commits.
    const awakened = await pending;
    if (Array.isArray(awakened)) terminalProxy(awakened);
    expect(harness.controller.getState().runtimeHealth).toBe("healthy");
    expect(await harness.controller.decideProxyForRequest("https://pending.invalid/")).toEqual({
      type: "direct",
    });
  });

  it("does not call the GeoIP provider for a direct profile without personal-data consent", async () => {
    const harness = createHarness({
      readDataCollection: async () => ({ apiAvailable: true, optionalGranted: [] }),
    });
    const profile = makeProfile({
      id: "profile-direct-1",
      proxy: { type: "direct", proxyDNS: false, bypassHosts: [] },
      identity: {
        mode: "manual",
        latitude: 35,
        longitude: 139,
        accuracy: 1000,
        timezone: "Asia/Tokyo",
      },
    });
    await harness.saveProfile(profile);
    const state = await harness.controller.activate(profile.id);

    expect(harness.providerResolveCount()).toBe(0);
    expect(state.lastError?.code).toBe("consent_required");
    expect(state.identity.latitude).toBe(35);
    expect(state.identity.timezone).toBe("Asia/Tokyo");
    expect(state.status).toBe("ready");
  });

  it("calls the GeoIP provider for a proxied profile without the optional personal-data grant", async () => {
    const harness = createHarness({
      readDataCollection: async () => ({ apiAvailable: true, optionalGranted: [] }),
    });
    const profile = makeProfile({ id: "profile-proxied-consent" });
    await harness.saveProfile(profile);
    const state = await harness.controller.activate(profile.id);

    expect(harness.providerResolveCount()).toBe(1);
    expect(state.lastError).toBeUndefined();
    expect(state.identity.publicIp).toBe(SAMPLE_GEO.ip);
  });

  it("does not call the GeoIP provider when the consent API is unavailable", async () => {
    const harness = createHarness({
      readDataCollection: async () => ({ apiAvailable: false, optionalGranted: [] }),
    });
    const profile = makeProfile({ id: "profile-no-api" });
    await harness.saveProfile(profile);
    await harness.controller.activate(profile.id);
    expect(harness.providerResolveCount()).toBe(0);
  });
});
