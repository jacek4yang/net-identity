/**
 * Test helpers.
 *
 * Every Firefox dependency is replaced by an in-memory implementation, which is why
 * the activation lifecycle, the proxy decision logic and the message router are all
 * testable without launching a browser. No test in this repository requires network
 * access.
 */
import { createActiveTargetStore, type ActiveTargetStore } from "../src/background/active-target";
import { createCredentialStore, type CredentialStore } from "../src/background/credentials";
import { ActivationController, type ActivationDeps } from "../src/background/identity";
import type { FirefoxProxySettingsSnapshot } from "../src/background/proxy";
import type { WebRtcSettingLike } from "../src/background/webrtc";
import { createWebRtcController } from "../src/background/webrtc";
import { GeoIpError, type GeoIpProvider, type GeoIpResult } from "../src/geo/provider";
import {
  createProfileStore,
  mutateProfiles,
  upsertProfile,
  type ProfileStore,
} from "../src/profile/store";
import type { IdentityProfile } from "../src/profile/schema";
import { parseProfile } from "../src/profile/validation";
import type { IdentityEnvelope } from "../src/shared/public-identity";
import type { ContentRuntimeState, RuntimeState } from "../src/shared/state";
import type { StorageAreaLike } from "../src/shared/storage";

/* ------------------------------------------------------------------- storage */

export interface MemoryStorage extends StorageAreaLike {
  snapshot(): Record<string, unknown>;
  serialized(): string;
}

export function createMemoryStorage(initial: Record<string, unknown> = {}): MemoryStorage {
  let store: Record<string, unknown> = structuredClone(initial);

  return {
    async get(keys) {
      if (keys === undefined || keys === null) return structuredClone(store);
      const list = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of list) {
        if (key in store) result[key] = structuredClone(store[key]);
      }
      return result;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        store[key] = structuredClone(value);
      }
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    },
    async clear() {
      store = {};
    },
    snapshot: () => structuredClone(store),
    serialized: () => JSON.stringify(store),
  };
}

/* ------------------------------------------------------------------ profiles */

export function makeProfile(overrides: Partial<IdentityProfile> & { id: string }): IdentityProfile {
  return {
    name: "Test profile",
    proxy: {
      type: "http",
      host: "127.0.0.1",
      port: 8080,
      proxyDNS: false,
      bypassHosts: ["localhost", "127.0.0.1", "::1"],
    },
    identity: { mode: "auto" },
    webrtcPolicy: "disable_non_proxied_udp",
    ...overrides,
  };
}

/* ----------------------------------------------------------------- provider */

export function createStaticProvider(result: GeoIpResult, id = "fake.geoip"): GeoIpProvider {
  return {
    id,
    label: id,
    endpoint: `https://${id}/`,
    resolve: async () => result,
  };
}

export function createFailingProvider(
  message = "provider unreachable",
  code: "network" | "timeout" | "http" | "malformed" | "aborted" = "network",
): GeoIpProvider {
  return {
    id: "fake.failing",
    label: "fake.failing",
    endpoint: "https://fake.failing/",
    resolve: async () => {
      throw new GeoIpError(code, message);
    },
  };
}

export function createScriptedProvider(
  script: (signal?: AbortSignal) => Promise<GeoIpResult>,
  id = "fake.scripted",
): GeoIpProvider {
  return { id, label: id, endpoint: `https://${id}/`, resolve: script };
}

export const SAMPLE_GEO: GeoIpResult = {
  ip: "203.0.113.7",
  countryCode: "NL",
  region: "North Holland",
  city: "Amsterdam",
  latitude: 52.374,
  longitude: 4.88969,
  timezone: "Europe/Amsterdam",
};

/* -------------------------------------------------------------------- webrtc */

export interface FakeWebRtcSetting extends WebRtcSettingLike {
  stored: { value: string; levelOfControl: string };
  setCalls: number;
  failNextSet: boolean;
  throwNextSet: boolean;
}

export function createFakeWebRtcSetting(
  initial: { value?: string; levelOfControl?: string } = {},
): FakeWebRtcSetting {
  const setting: FakeWebRtcSetting = {
    stored: {
      value: initial.value ?? "default",
      levelOfControl: initial.levelOfControl ?? "controllable_by_this_extension",
    },
    setCalls: 0,
    failNextSet: false,
    throwNextSet: false,

    async get() {
      return { value: setting.stored.value, levelOfControl: setting.stored.levelOfControl };
    },

    async set(details) {
      setting.setCalls += 1;
      if (setting.throwNextSet) {
        setting.throwNextSet = false;
        throw new Error("privacy setting rejected");
      }
      if (setting.failNextSet) {
        setting.failNextSet = false;
        return false;
      }
      setting.stored.value = String(details.value);
      return undefined;
    },
  };

  return setting;
}

/* ------------------------------------------------------------------- timing */

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function createDeferred<T>(): Deferred<T> {
  const holder: { resolve?: (value: T) => void; reject?: (error: unknown) => void } = {};
  const promise = new Promise<T>((resolve, reject) => {
    holder.resolve = resolve;
    holder.reject = reject;
  });
  return {
    promise,
    resolve: (value) => holder.resolve?.(value),
    reject: (error) => holder.reject?.(error),
  };
}

export interface Clock {
  now: () => number;
  advance: (milliseconds: number) => number;
}

/** Waits for a condition that is satisfied by an asynchronous side effect. */
export async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function createClock(start = 1_700_000_000_000): Clock {
  let current = start;
  return {
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
      return current;
    },
  };
}

/* ------------------------------------------------------------------ harness */

export const DEFAULT_FIREFOX_PROXY: FirefoxProxySettingsSnapshot = {
  proxyType: "none",
  levelOfControl: "controllable_by_this_extension",
};

export interface HarnessOptions {
  provider?: GeoIpProvider;
  webrtcSetting?: FakeWebRtcSetting;
  firefoxProxy?: FirefoxProxySettingsSnapshot;
  probeContent?: (generation: number) => Promise<ContentRuntimeState>;
  now?: () => number;
  /** Reuse the storage areas of a previous harness to simulate an event page restart. */
  localArea?: MemoryStorage;
  sessionArea?: MemoryStorage;
}

export interface Harness {
  controller: ActivationController;
  deps: ActivationDeps;
  localArea: MemoryStorage;
  sessionArea: MemoryStorage;
  profileStore: ProfileStore;
  credentialStore: CredentialStore;
  targetStore: ActiveTargetStore;
  webrtcSetting: FakeWebRtcSetting;
  clock: Clock;
  states: RuntimeState[];
  envelopes: IdentityEnvelope[];
  providerResolveCount: () => number;
  setProvider: (provider: GeoIpProvider) => void;
  setProbeContent: (probe: (generation: number) => Promise<ContentRuntimeState>) => void;
  saveProfile: (profile: IdentityProfile) => Promise<void>;
  storedActiveProfileId: () => Promise<string | null>;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const localArea = options.localArea ?? createMemoryStorage();
  const sessionArea = options.sessionArea ?? createMemoryStorage();
  const profileStore = createProfileStore(localArea);
  const credentialStore = createCredentialStore(sessionArea);
  const targetStore = createActiveTargetStore(sessionArea);
  const webrtcSetting = options.webrtcSetting ?? createFakeWebRtcSetting();
  const clock = createClock();
  const now = options.now ?? clock.now;

  let provider = options.provider ?? createStaticProvider(SAMPLE_GEO);
  let providerCalls = 0;
  let probeContent =
    options.probeContent ??
    (async (): Promise<ContentRuntimeState> => ({ hasShim: false, reportedGeneration: null }));

  const states: RuntimeState[] = [];
  const envelopes: IdentityEnvelope[] = [];

  const deps: ActivationDeps = {
    profiles: profileStore,
    credentials: credentialStore,
    targets: targetStore,
    webrtc: createWebRtcController(webrtcSetting),
    provider: {
      id: "harness",
      label: "harness",
      endpoint: "https://harness/",
      async resolve(signal?: AbortSignal) {
        providerCalls += 1;
        return provider.resolve(signal);
      },
    },
    readFirefoxProxySettings: async () => options.firefoxProxy ?? DEFAULT_FIREFOX_PROXY,
    broadcastState: (state) => {
      states.push(state);
    },
    broadcastIdentity: (envelope) => {
      envelopes.push(envelope);
    },
    probeContent: (generation) => probeContent(generation),
    now,
  };

  return {
    controller: new ActivationController(deps),
    deps,
    localArea,
    sessionArea,
    profileStore,
    credentialStore,
    targetStore,
    webrtcSetting,
    clock,
    states,
    envelopes,
    providerResolveCount: () => providerCalls,
    setProvider: (next) => {
      provider = next;
    },
    setProbeContent: (probe) => {
      probeContent = probe;
    },
    saveProfile: async (profile) => {
      const validated = parseProfile(profile);
      if (!validated.ok) throw new Error(`invalid test profile: ${validated.errors.join("; ")}`);
      const result = await mutateProfiles(profileStore, (state) =>
        upsertProfile(state, validated.value),
      );
      if (!result.ok) throw new Error(result.errors.join("; "));
    },
    storedActiveProfileId: async () => (await profileStore.load()).activeProfileId,
  };
}
