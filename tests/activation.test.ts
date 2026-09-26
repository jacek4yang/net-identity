/**
 * Activation lifecycle tests.
 *
 * These cover the guarantees that make the extension trustworthy: identity comes
 * from the observed egress IP, a slow response from an older activation can never
 * overwrite a newer one, credentials stay in session storage, routing survives a
 * background restart, and deactivation really stops the spoofing.
 */
import { describe, expect, it } from "vitest";
import { GEOIP_ACCURACY_METERS, PAGE_SOURCE } from "../src/shared/constants";
import type { GeoIpResult } from "../src/geo/provider";
import {
  SAMPLE_GEO,
  createDeferred,
  createFailingProvider,
  createHarness,
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

describe("activation", () => {
  it("activates a profile atomically and publishes the observed identity", async () => {
    const harness = createHarness({
      // Simulate an open tab whose shim already applied the new identity, which is
      // what makes the audit report a fully consistent state.
      probeContent: async (generation) => ({
        hasShim: true,
        reportedGeneration: generation,
        reportedTimezone: "Europe/Amsterdam",
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
        username: "user",
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
    const decision = await harness.controller.decideProxyForRequest("https://example.com/");
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
    const decision = await harness.controller.decideProxyForRequest("https://example.com/");
    expect(decision.type).toBe("http");
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
    expect(stored.profiles[0]?.identity.latitude).toBe(48.8566);
    expect(stored.profiles[0]?.identity.city).toBeUndefined();
  });

  it("persists auto-resolved values back into the profile", async () => {
    const harness = createHarness();
    const profile = makeProfile({ id: "profile-0007" });
    await harness.saveProfile(profile);

    await harness.controller.activate(profile.id);
    const stored = await harness.profileStore.load();

    expect(stored.profiles[0]?.identity.publicIp).toBe(SAMPLE_GEO.ip);
    expect(stored.profiles[0]?.identity.timezone).toBe("Europe/Amsterdam");
    expect(stored.profiles[0]?.identity.lastResolvedAt).toBe(harness.clock.now());
    expect(JSON.stringify(stored).toLowerCase()).not.toContain("password");
  });

  it("deactivates: clears routing, restores the WebRTC default and stops spoofing", async () => {
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
    expect(harness.webrtcSetting.stored.value).toBe("default");
    expect(harness.sessionArea.snapshot()["ni.active-target.v1"]).toBeUndefined();
    expect(await harness.storedActiveProfileId()).toBeNull();
    // The last envelope tells pages to go back to native behaviour.
    expect(harness.envelopes.at(-1)?.payload).toBeNull();
    expect(harness.envelopes.at(-1)?.pending).toBe(false);
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

    harness.controller.recordContentReport({
      source: PAGE_SOURCE,
      type: "applied",
      generation: state.generation - 1,
      timezone: "Europe/Amsterdam",
      hasGeolocationOverride: true,
    });

    await waitUntil(() => harness.controller.getState().content.reportedGeneration !== null);
    expect(checkStatus(harness, "content_shim")).toBe("stale");
  });

  it("marks the page shim as current when generation and timezone agree", async () => {
    const harness = createHarness({
      probeContent: async (generation) => ({
        hasShim: true,
        reportedGeneration: generation,
        reportedTimezone: "Europe/Amsterdam",
      }),
    });
    const profile = makeProfile({ id: "profile-0011" });
    await harness.saveProfile(profile);

    const state = await harness.controller.activate(profile.id);

    expect(state.content.hasShim).toBe(true);
    expect(state.content.reportedGeneration).toBe(state.generation);
    expect(checkStatus(harness, "content_shim")).toBe("ok");
  });

  it("surfaces proxy errors without leaking credentials", async () => {
    const harness = createHarness();
    const profile = makeProfile({ id: "profile-0012" });
    await harness.saveProfile(profile);
    await harness.controller.activate(profile.id);

    harness.controller.recordProxyError(new Error("Proxy-Authorization: Basic dXNlcjpwdw=="));
    await waitUntil(() => harness.controller.getState().lastError?.code === "proxy_error");

    const message = harness.controller.getState().lastError?.message ?? "";
    expect(message).not.toContain("dXNlcjpwdw==");
    expect(message).toContain("[redacted]");
  });
});

describe("background restart", () => {
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
    const decision = await restarted.controller.decideProxyForRequest("https://example.com/");
    expect(decision.type).toBe("http");
    expect(decision.host).toBe("127.0.0.1");

    // A loopback bypass still applies while restoring.
    expect(await restarted.controller.decideProxyForRequest("http://localhost:3000/")).toEqual({
      type: "direct",
    });
  });

  it("is direct when there is no session snapshot", async () => {
    const harness = createHarness();
    expect(await harness.controller.decideProxyForRequest("https://example.com/")).toEqual({
      type: "direct",
    });
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
});
