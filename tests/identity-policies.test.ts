import { describe, expect, it } from "vitest";
import { createMessageHandler } from "../src/background/messages";
import { parseProfile } from "../src/profile/validation";
import { parseResolvedIdentity, parseRuntimeState } from "../src/shared/state";
import { parseActiveTargetSnapshot } from "../src/background/active-target";
import { locationTimezoneWarning } from "../src/options/identity-warning";
import {
  createHarness,
  makeProfile,
  SAMPLE_GEO,
  createDeferred,
  createScriptedProvider,
  waitUntil,
} from "./helpers";

describe("independent identity policies", () => {
  it("warns about an apparent longitude/timezone mismatch without rejecting it", () => {
    const date = Date.UTC(2026, 6, 1);
    expect(locationTimezoneWarning(139, "Asia/Tokyo", date)).toBeNull();
    expect(locationTimezoneWarning(139, "America/New_York", date)).toContain("unchanged");
    expect(locationTimezoneWarning(NaN, "Mars", date)).toBeNull();
  });
  it("keeps the observed GeoIP seed separate from expert overrides and validates it", async () => {
    const h = createHarness();
    await h.saveProfile(
      makeProfile({
        id: "seed-000001",
        identity: { mode: "manual", latitude: 1, longitude: 2, accuracy: 3, timezone: "UTC" },
      }),
    );
    const state = await h.controller.activate("seed-000001");
    expect(state.identity.latitude).toBe(1);
    expect(state.identity.geoIpLocation?.latitude).toBe(SAMPLE_GEO.latitude);
    expect(parseResolvedIdentity(state.identity).ok).toBe(true);
    expect(
      parseResolvedIdentity({
        ...state.identity,
        geoIpLocation: { latitude: 91, longitude: 2, accuracy: 3 },
      }).ok,
    ).toBe(false);
    expect(parseRuntimeState({ ...state, appliedRevision: -1 }).ok).toBe(false);
    const snapshot = await h.targetStore.load();
    expect(parseActiveTargetSnapshot({ ...snapshot, appliedRevision: "1" }).ok).toBe(false);
    expect(parseActiveTargetSnapshot({ ...snapshot, appliedRevision: 0 }).ok).toBe(false);
    expect(parseActiveTargetSnapshot({ ...snapshot, appliedRevision: 2 }).ok).toBe(false);
    expect(
      parseActiveTargetSnapshot({ ...snapshot, proxy: { ...snapshot?.proxy, port: 3128 } }).ok,
    ).toBe(false);
    expect(
      parseActiveTargetSnapshot({ ...snapshot, profileId: "builtin-direct", profile: undefined })
        .ok,
    ).toBe(false);
    expect(
      parseActiveTargetSnapshot({ ...snapshot, profile: undefined, appliedRevision: undefined }),
    ).toMatchObject({
      ok: true,
      value: { appliedRevision: 1 },
    });
    expect(parseProfile({ ...makeProfile({ id: "revision-bad" }), revision: 0 }).ok).toBe(false);
  });
  it("never starts an obsolete provider request after a slow consent read", async () => {
    const consent = createDeferred<{ apiAvailable: boolean; optionalGranted: string[] }>();
    let reads = 0;
    const h = createHarness({
      readDataCollection: () => {
        reads++;
        return consent.promise;
      },
    });
    await h.saveProfile(makeProfile({ id: "consent-race" }));
    const activating = h.controller.activate("consent-race");
    await waitUntil(() => reads === 1);
    await h.controller.deactivate();
    consent.resolve({ apiAvailable: true, optionalGranted: [] });
    await activating;
    expect(h.providerResolveCount()).toBe(0);
  });
  for (const geoIpPolicy of ["automatic", "disabled"] as const) {
    for (const geolocationPolicy of ["follow", "manual", "disabled"] as const) {
      for (const timezonePolicy of ["follow", "manual"] as const) {
        it(`${geoIpPolicy} GeoIP / ${geolocationPolicy} location / ${timezonePolicy} timezone`, async () => {
          const h = createHarness();
          const profile = makeProfile({
            id: "policies-0001",
            identity: {
              mode: "manual",
              geoIpPolicy,
              geolocationPolicy,
              timezonePolicy,
              latitude: 35,
              longitude: 139,
              accuracy: 100,
              timezone: "Asia/Tokyo",
            },
          });
          await h.saveProfile(profile);
          const state = await h.controller.activate(profile.id);
          expect(h.providerResolveCount()).toBe(geoIpPolicy === "automatic" ? 1 : 0);
          expect(state.identity.latitude).toBe(
            geolocationPolicy === "manual"
              ? 35
              : geolocationPolicy === "follow" && geoIpPolicy === "automatic"
                ? SAMPLE_GEO.latitude
                : undefined,
          );
          expect(state.identity.timezone).toBe(
            timezonePolicy === "manual"
              ? "Asia/Tokyo"
              : geoIpPolicy === "automatic"
                ? SAMPLE_GEO.timezone
                : undefined,
          );
          expect(state.identity.publicIp).toBe(
            geoIpPolicy === "automatic" ? SAMPLE_GEO.ip : undefined,
          );
          expect(h.controller.getEnvelope().controlled).toBe(true);
        });
      }
    }
  }
  for (const policy of [
    "default",
    "default_public_interface_only",
    "disable_non_proxied_udp",
    "proxy_only",
  ] as const) {
    it(`preserves explicit WebRTC ${policy}`, async () => {
      const h = createHarness();
      await h.saveProfile(
        makeProfile({ id: "webrtc-0001", webrtcMode: "manual", webrtcPolicy: policy }),
      );
      expect((await h.controller.activate("webrtc-0001")).webrtc.desired).toBe(policy);
    });
  }
  it("uses route recommendation in automatic WebRTC mode", async () => {
    const h = createHarness();
    await h.saveProfile(
      makeProfile({ id: "webrtc-auto", webrtcMode: "automatic", webrtcPolicy: "default" }),
    );
    expect((await h.controller.activate("webrtc-auto")).webrtc.desired).toBe(
      "disable_non_proxied_udp",
    );
  });
  for (const invalid of [
    { geoIpPolicy: "native" },
    { providerId: "https://evil.test" },
    { geolocationPolicy: "native" },
    { timezonePolicy: "guess" },
  ]) {
    it(`rejects malformed policy ${JSON.stringify(invalid)}`, () => {
      expect(
        parseProfile({
          ...makeProfile({ id: "invalid-0001" }),
          identity: { mode: "auto", ...invalid },
        }).ok,
      ).toBe(false);
    });
  }
  it("keeps Direct virtual and clears the prior proxy identity without permission", async () => {
    const h = createHarness({
      readDataCollection: async () => ({ apiAvailable: true, optionalGranted: [] }),
    });
    await h.saveProfile(makeProfile({ id: "proxy-000001" }));
    await h.controller.activate("proxy-000001");
    const state = await h.controller.activate("builtin-direct");
    expect(state.proxy.type).toBe("direct");
    expect(state.identity.publicIp).toBeUndefined();
    expect(state.identity.latitude).toBeUndefined();
    expect(h.controller.getEnvelope()).toMatchObject({
      controlled: true,
      pending: false,
      payload: null,
    });
    expect(h.localArea.serialized()).not.toContain('"id":"builtin-direct"');
    expect(h.providerResolveCount()).toBe(1);
    await h.controller.deactivate();
    expect(h.controller.getEnvelope().controlled).toBe(false);
    expect(h.webrtcSetting.clearCalls).toBe(1);
  });
  it("preserves pending edits through refresh and event-page restart", async () => {
    const h = createHarness();
    const handler = createMessageHandler({
      profiles: h.profileStore,
      credentials: h.credentialStore,
      controller: h.controller,
      runtimeId: "test",
    });
    const sender = { id: "test", fromContentScript: false, url: undefined };
    const profile = makeProfile({ id: "revision-0001" });
    await handler({ type: "profiles:save", profile }, sender);
    await h.controller.activate(profile.id);
    await handler(
      { type: "profiles:save", profile: { ...profile, proxy: { ...profile.proxy, port: 3128 } } },
      sender,
    );
    await h.controller.refresh();
    expect(h.controller.getTarget()?.proxy.port).toBe(8080);
    const restarted = createHarness({ localArea: h.localArea, sessionArea: h.sessionArea });
    expect((await restarted.controller.initialize()).appliedRevision).toBe(1);
    await restarted.controller.refresh();
    expect(restarted.controller.getTarget()?.proxy.port).toBe(8080);
    expect((await restarted.controller.activate(profile.id)).appliedRevision).toBe(2);
    expect(restarted.controller.getTarget()?.proxy.port).toBe(3128);
  });
  it("switches Direct routing before consent resolves and restores it without a stored profile", async () => {
    const consent = createDeferred<{ apiAvailable: boolean; optionalGranted: string[] }>();
    let reads = 0;
    const h = createHarness({
      readDataCollection: () => {
        reads++;
        return consent.promise;
      },
    });
    const activation = h.controller.activate("builtin-direct");
    await waitUntil(() => reads === 1);
    expect(await h.controller.decideProxyForRequest("https://example.test")).toEqual({
      type: "direct",
    });
    expect(h.controller.getState().identity.timezone).toBeUndefined();
    expect(h.localArea.serialized()).not.toContain('"id":"builtin-direct"');
    consent.resolve({ apiAvailable: true, optionalGranted: [] });
    await activation;
    const restarted = createHarness({ localArea: h.localArea, sessionArea: h.sessionArea });
    const state = await restarted.controller.initialize();
    expect(state.activeProfileId).toBe("builtin-direct");
    expect(state.identity.timezone).toBeUndefined();
    expect(restarted.providerResolveCount()).toBe(0);
    expect(restarted.controller.getEnvelope()).toMatchObject({ controlled: true, payload: null });
  });
  it("resumes an interrupted Apply with its snapshot revision and credentials", async () => {
    const h = createHarness();
    const handler = createMessageHandler({
      profiles: h.profileStore,
      credentials: h.credentialStore,
      controller: h.controller,
      runtimeId: "test",
    });
    const sender = { id: "test", fromContentScript: false, url: undefined };
    const profile = makeProfile({ id: "interrupted-apply" });
    await handler(
      {
        type: "profiles:save",
        profile,
        credentials: { username: "fixture", password: "fixture-only" },
      },
      sender,
    );
    await h.controller.activate(profile.id);
    const snapshot = await h.targetStore.load();
    if (snapshot === null) throw new Error("missing applied snapshot");
    await h.targetStore.save({ ...snapshot, status: "resolving" });
    await handler(
      {
        type: "profiles:save",
        profile: { ...profile, proxy: { ...profile.proxy, port: 3128 } },
        credentials: null,
      },
      sender,
    );
    const restarted = createHarness({ localArea: h.localArea, sessionArea: h.sessionArea });
    const state = await restarted.controller.initialize();
    expect(state.appliedRevision).toBe(1);
    expect(state.generation).toBeGreaterThan(snapshot.generation);
    expect(restarted.controller.getTarget()?.proxy.port).toBe(8080);
    expect(restarted.controller.getTarget()?.credentials?.username).toBe("fixture");
    await restarted.controller.refresh();
    expect(restarted.controller.getTarget()?.credentials?.username).toBe("fixture");
    await restarted.controller.activate(profile.id);
    expect(restarted.controller.getTarget()?.proxy.port).toBe(3128);
    expect(restarted.controller.getTarget()?.credentials).toBeNull();
    expect(h.localArea.serialized()).not.toContain("fixture-only");
  });
  it("keeps applied credentials through Save, Clear, duplicate and a ready restart until Apply", async () => {
    const h = createHarness();
    const handler = createMessageHandler({
      profiles: h.profileStore,
      credentials: h.credentialStore,
      controller: h.controller,
      runtimeId: "test",
    });
    const sender = { id: "test", fromContentScript: false, url: undefined };
    const profile = makeProfile({
      id: "credential-revision",
      identity: { mode: "auto", geoIpPolicy: "disabled" },
    });
    await handler(
      {
        type: "profiles:save",
        profile,
        credentials: { username: "fixture", password: "fixture-only" },
      },
      sender,
    );
    await h.controller.activate(profile.id);
    const generation = h.controller.getState().generation;
    await handler({ type: "profiles:save", profile }, sender);
    expect((await h.credentialStore.get(profile.id))?.username).toBe("fixture");
    await handler({ type: "profiles:duplicate", profileId: profile.id }, sender);
    const copy = (await h.profileStore.load()).profiles.find((p) => p.name.endsWith(" copy"));
    expect(copy).toBeDefined();
    expect(await h.credentialStore.get(copy?.id ?? "missing")).toBeNull();
    await handler({ type: "profiles:save", profile, credentials: null }, sender);
    expect(h.controller.getState().generation).toBe(generation);
    expect(await h.credentialStore.get(profile.id)).toBeNull();
    const restarted = createHarness({ localArea: h.localArea, sessionArea: h.sessionArea });
    await restarted.controller.initialize();
    await restarted.controller.refresh();
    expect(restarted.controller.getTarget()?.credentials?.username).toBe("fixture");
    await restarted.controller.activate(profile.id);
    expect(restarted.controller.getTarget()?.credentials).toBeNull();
    expect(h.localArea.serialized()).not.toContain("fixture-only");
  });
  it("lets Off win a lookup and an activation still loading storage", async () => {
    const deferred = createDeferred<typeof SAMPLE_GEO>();
    const h = createHarness({ provider: createScriptedProvider(() => deferred.promise) });
    await h.saveProfile(makeProfile({ id: "race-000001" }));
    const first = h.controller.activate("race-000001");
    await waitUntil(() => h.providerResolveCount() === 1);
    const second = h.controller.activate("builtin-direct");
    await h.controller.deactivate();
    deferred.resolve(SAMPLE_GEO);
    await Promise.all([first, second]);
    expect(h.controller.getState().status).toBe("idle");
    expect(h.controller.getTarget()).toBeNull();
    expect(await h.targetStore.load()).toBeNull();
    expect(await h.storedActiveProfileId()).toBeNull();
  });
});
