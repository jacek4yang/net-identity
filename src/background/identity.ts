/**
 * Profile activation.
 *
 * Switching a profile is treated as ONE state transition, not a set of
 * independent updates:
 *
 *   select profile -> validate -> activate proxy routing -> activate WebRTC policy
 *   -> resolve the observed proxy egress identity -> publish derived GeoIP/timezone
 *   -> broadcast the public identity to pages -> update the UI
 *
 * Rules enforced here:
 *   - Identity is derived from the OBSERVED public egress IP after the proxy is
 *     active. It is never derived from the proxy server's hostname.
 *   - Every activation takes a new generation token. A response belonging to an
 *     older generation is discarded, so a slow GeoIP lookup can never overwrite a
 *     newer profile.
 *   - Activation never throws at the caller: failures become a precise state and
 *     audit entry instead.
 *   - The session snapshot is written as soon as routing changes, so a suspended
 *     background page can never silently fall back to a direct connection.
 *
 * All collaborators are injected, so the whole lifecycle is unit testable without
 * Firefox.
 */
import {
  forgetContentTab,
  recordContentDiagnostic,
  summarizeContentDiagnostics,
  type ContentDiagnostic,
  type ContentProbeResult,
} from "../shared/content-diagnostics";
import { GEOIP_ACCURACY_METERS } from "../shared/constants";
import { buildAuditReport } from "../shared/audit";
import {
  createIdentityEnvelope,
  createPublicIdentity,
  type IdentityEnvelope,
  type PageAppliedReport,
} from "../shared/public-identity";
import { describeError } from "../shared/result";
import {
  createInitialRuntimeState,
  createRuntimeState,
  type ContentRuntimeState,
  type ProxyRuntimeSummary,
  type ResolvedIdentity,
  type RuntimeErrorInfo,
  type RuntimeState,
  type RuntimeStatus,
  type WebRtcRuntimeState,
} from "../shared/state";
import { decideGeoIpConsent, type DataCollectionSnapshot } from "./consent";
import { describeGeoIpFailure, type GeoIpProvider, type GeoIpResult } from "../geo/provider";
import {
  isBuiltinDirectProfile,
  defaultWebRtcPolicyFor,
  isProxied,
  type IdentityProfile,
} from "../profile/schema";
import {
  findProfile,
  mutateProfiles,
  setActiveProfile,
  upsertProfile,
  type ProfileStore,
} from "../profile/store";
import { parseProfile } from "../profile/validation";
import {
  ACTIVE_TARGET_SCHEMA_VERSION,
  type ActiveTargetSnapshot,
  type ActiveTargetStore,
} from "./active-target";
import type { CredentialStore } from "./credentials";
import {
  decideProxy,
  decideProxyAuth,
  type ActiveProxyTarget,
  type FirefoxProxySettingsSnapshot,
  type ProxyAuthChallenge,
  type ProxyAuthCredentials,
} from "./proxy";
import { createPendingWebRtcState, describeObservedWebRtc, type WebRtcController } from "./webrtc";

export interface ActivationDeps {
  profiles: ProfileStore;
  credentials: CredentialStore;
  targets: ActiveTargetStore;
  webrtc: WebRtcController;
  provider: GeoIpProvider;
  readFirefoxProxySettings: () => Promise<FirefoxProxySettingsSnapshot>;
  broadcastState: (state: RuntimeState) => void | Promise<void>;
  broadcastIdentity: (envelope: IdentityEnvelope) => void | Promise<void>;
  /** Asks open tabs what their page shim actually applied. Diagnostic only. */
  probeContent: (generation: number) => Promise<ContentProbeResult>;
  /** Firefox's optional data-collection grants. Fail closed when this throws. */
  readDataCollection: () => Promise<DataCollectionSnapshot>;
  now: () => number;
}

interface IdentityResolution {
  identity: ResolvedIdentity;
  providerFailed: boolean;
  providerError: string | undefined;
  consentBlocked: boolean;
}

const EMPTY_CONTENT_STATE: ContentRuntimeState = {
  hasShim: false,
  reportedGeneration: null,
  frameCount: 0,
  currentFrameCount: 0,
  activeTabId: null,
  activeTabCurrent: false,
};

/** Projects the resolved identity onto the profile shape used for state display. */
function identityConfigFrom(identity: ResolvedIdentity): IdentityProfile["identity"] {
  return {
    mode: identity.source,
    ...(identity.publicIp === undefined ? {} : { publicIp: identity.publicIp }),
    ...(identity.countryCode === undefined ? {} : { countryCode: identity.countryCode }),
    ...(identity.region === undefined ? {} : { region: identity.region }),
    ...(identity.city === undefined ? {} : { city: identity.city }),
    ...(identity.latitude === undefined ? {} : { latitude: identity.latitude }),
    ...(identity.longitude === undefined ? {} : { longitude: identity.longitude }),
    ...(identity.accuracy === undefined ? {} : { accuracy: identity.accuracy }),
    ...(identity.timezone === undefined ? {} : { timezone: identity.timezone }),
    ...(identity.resolvedAt === undefined ? {} : { lastResolvedAt: identity.resolvedAt }),
  };
}

export class ActivationController {
  private readonly deps: ActivationDeps;
  private generation = 0;
  private target: ActiveProxyTarget | null = null;
  private appliedProfile: IdentityProfile | null = null;
  private state: RuntimeState;
  private content: ContentRuntimeState = { ...EMPTY_CONTENT_STATE };
  private diagnostics: ContentDiagnostic[] = [];
  private activeTabId: number | null = null;
  private abortController: AbortController | null = null;
  private pendingTargetLoad: Promise<ActiveProxyTarget | null> | null = null;
  /**
   * `absent` means a restore already found no usable snapshot. Further requests
   * answer from that memory until activation or deactivation changes it.
   */
  private snapshotRestore: "unknown" | "absent" = "unknown";

  private snapshotWasCleared(): boolean {
    return this.snapshotRestore === "absent";
  }
  /**
   * False until the first committed startup result. Content scripts that ask
   * before then are told geolocation is controlled, so a restoring profile
   * cannot leak the host position.
   */
  private initialized = false;
  /**
   * True while `deactivate()` is mid-transition. A WebRTC `onChange` fires during
   * that window (the release writes the setting), and must not observe a
   * profile-less state that still carries the old identity coordinates.
   */
  private deactivating = false;
  private settingsQueue: Promise<unknown> = Promise.resolve();
  private changeWebRtc(operation: () => Promise<WebRtcRuntimeState>): Promise<WebRtcRuntimeState> {
    const next = this.settingsQueue.then(operation, operation);
    this.settingsQueue = next.catch(() => undefined);
    return next;
  }

  constructor(deps: ActivationDeps) {
    this.deps = deps;
    this.state = createInitialRuntimeState(deps.now());
  }

  getState(): RuntimeState {
    return this.state;
  }

  getTarget(): ActiveProxyTarget | null {
    return this.target;
  }

  /** Current payload for content scripts, including the "an identity is coming" flag. */
  getEnvelope(): IdentityEnvelope {
    if (!this.initialized) return createIdentityEnvelope(null, true, true);
    return this.buildEnvelope(this.isBusy());
  }

  private isBusy(): boolean {
    return this.state.status === "activating" || this.state.status === "resolving";
  }

  private buildEnvelope(pending: boolean): IdentityEnvelope {
    // Identity coordinates belong to a profile. With no active profile there is
    // nothing to publish, so a state that still carries the previous coordinates
    // (a transition, or a setting refresh racing a deactivation) cannot leak them
    // to pages.
    if (this.state.activeProfileId === null) {
      return createIdentityEnvelope(
        null,
        pending,
        this.isBusy() || (this.deactivating && this.state.status !== "idle"),
      );
    }
    const payload = createPublicIdentity({
      generation: this.state.generation,
      latitude: this.state.identity.latitude,
      longitude: this.state.identity.longitude,
      accuracy: this.state.identity.accuracy,
      timezone: this.state.identity.timezone,
    });
    return createIdentityEnvelope(payload, pending, true);
  }

  /**
   * Proxy decision for one request.
   *
   * Synchronous when the target is already in memory. If the background event page
   * was suspended and restarted, the session snapshot is loaded first: answering
   * "direct" during that window would silently send traffic outside the proxy.
   */
  decideProxyForRequest(url: string): browser.proxy.ProxyInfo | Promise<browser.proxy.ProxyInfo> {
    if (this.target !== null) return decideProxy(this.target, url);
    if (this.snapshotRestore === "absent") return decideProxy(null, url);
    if (this.pendingTargetLoad === null) {
      this.pendingTargetLoad = this.loadTargetFromSnapshot().finally(() => {
        this.pendingTargetLoad = null;
      });
    }
    return this.pendingTargetLoad.then((target) => decideProxy(this.target ?? target, url));
  }

  private async loadTargetFromSnapshot(): Promise<ActiveProxyTarget | null> {
    if (this.target !== null) return this.target;

    const snapshot = await this.deps.targets.load();
    // Activation or deactivation can win while the session read is in flight.
    if (this.snapshotWasCleared() || this.target !== null) return this.target;

    if (snapshot === null) {
      this.snapshotRestore = "absent";
      return null;
    }

    const stored = await this.deps.profiles.load();
    if (this.snapshotWasCleared() || this.target !== null) return this.target;
    if (stored.activeProfileId !== snapshot.profileId) {
      this.snapshotRestore = "absent";
      return null;
    }

    this.generation = Math.max(this.generation, snapshot.generation);
    this.target = {
      profileId: snapshot.profileId,
      profileName: snapshot.profileName,
      generation: snapshot.generation,
      proxy: snapshot.proxy,
      credentials: snapshot.credentials,
    };
    return this.target;
  }

  decideProxyAuth(challenge: ProxyAuthChallenge): ProxyAuthCredentials | null {
    return decideProxyAuth(this.target, challenge);
  }

  /** Starts (or restores) the active profile. Never throws. */
  async initialize(): Promise<RuntimeState> {
    const epoch = this.generation;
    try {
      const stored = await this.deps.profiles.load();
      // Install and startup both run on first launch. If activation began while
      // this read was in flight, publishing idle here would release geolocation
      // while a profile is actually active.
      if (this.generation !== epoch) return this.state;
      const migrationWarning = this.deps.profiles.migrationWarning();
      if (migrationWarning !== null) {
        const idle = await this.composeIdleState(this.generation, {
          code: "schema_unsupported",
          message: migrationWarning,
        });
        if (this.generation !== epoch) return this.state;
        return await this.commit(idle, false);
      }
      if (stored.activeProfileId === null) {
        const idle = await this.composeIdleState(this.generation);
        if (this.generation !== epoch) return this.state;
        return await this.commit(idle, false);
      }

      const snapshot = await this.deps.targets.load();
      if (this.generation !== epoch) return this.state;
      const restorable =
        snapshot !== null &&
        snapshot.profileId === stored.activeProfileId &&
        (snapshot.status === "ready" || snapshot.status === "idle");

      if (snapshot !== null && restorable) {
        // The event page was restarted inside the same browser session: restore
        // in-memory routing immediately, without another GeoIP request.
        // Routing is published only after the settings read, and only if no
        // activation started while that read was in flight.
        const profile: IdentityProfile = snapshot.profile ?? {
          id: snapshot.profileId,
          name: snapshot.profileName,
          proxy: snapshot.proxy,
          identity: identityConfigFrom(snapshot.identity),
          webrtcPolicy: snapshot.webrtcPolicy,
          revision: snapshot.appliedRevision ?? 1,
        };
        const restored = await this.composeState({
          status: "ready",
          generation: snapshot.generation,
          profile,
          hasCredentials: snapshot.credentials !== null,
          identity: snapshot.identity,
          webrtc: snapshot.webrtc,
          providerFailed: false,
          content: { ...EMPTY_CONTENT_STATE },
        });
        if (this.generation !== epoch) return this.state;
        this.generation = Math.max(this.generation, snapshot.generation);
        this.target = {
          profileId: snapshot.profileId,
          profileName: snapshot.profileName,
          generation: snapshot.generation,
          proxy: snapshot.proxy,
          credentials: snapshot.credentials,
        };
        this.appliedProfile = profile;
        return await this.commit(restored, false);
      }

      if (this.generation !== epoch) return this.state;
      if (snapshot?.profile !== undefined && snapshot.profileId === stored.activeProfileId) {
        // An interrupted Apply already selected this configuration. Resume it,
        // never a newer Save made while its provider request was outstanding.
        this.generation = Math.max(this.generation, snapshot.generation);
        return await this.activate(stored.activeProfileId, {
          profile: snapshot.profile,
          credentials: snapshot.credentials,
        });
      }
      return await this.activate(stored.activeProfileId);
    } catch (error) {
      if (this.generation !== epoch) return this.state;
      return await this.failWith(
        "initialize_failed",
        describeError(error, "Could not initialise net-identity."),
      );
    }
  }

  async activate(
    profileId: string,
    applied?: { profile: IdentityProfile; credentials: ActiveProxyTarget["credentials"] },
  ): Promise<RuntimeState> {
    const generation = ++this.generation;
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    this.deactivating = false;
    try {
      const stored = await this.deps.profiles.load();
      if (generation !== this.generation) return this.state;
      const found = applied?.profile ?? findProfile(stored, profileId);
      if (found === null) {
        return await this.failWith("profile_missing", "That profile no longer exists.");
      }

      const validated = parseProfile(found);
      if (!validated.ok) {
        return await this.failWith("profile_invalid", validated.errors.join("; "));
      }
      const profile = validated.value;
      if (profile.webrtcMode === "automatic")
        profile.webrtcPolicy = defaultWebRtcPolicyFor(profile.proxy.type);
      const credentials =
        applied === undefined ? await this.deps.credentials.get(profile.id) : applied.credentials;

      if (generation !== this.generation) return this.state;
      this.diagnostics = [];
      this.activeTabId = null;
      this.content = { ...EMPTY_CONTENT_STATE };

      this.appliedProfile = profile;
      // Proxy routing becomes effective for subsequent requests immediately.
      this.target = {
        profileId: profile.id,
        profileName: profile.name,
        generation,
        proxy: profile.proxy,
        credentials,
      };

      const activeResult = await mutateProfiles(this.deps.profiles, (current) =>
        generation === this.generation
          ? setActiveProfile(current, profile.id)
          : { ok: true, value: current },
      );
      if (generation !== this.generation) return this.state;
      if (!activeResult.ok) {
        return await this.failWith("profile_not_persisted", activeResult.errors.join("; "));
      }

      const provisionalIdentity = { source: profile.identity.mode, publicIpVerified: false };
      const provisionalWebrtc = createPendingWebRtcState(profile.webrtcPolicy);

      // Snapshot first: a suspended background page must be able to restore routing
      // even if the identity lookup below never completes this session.
      await this.saveSnapshot({
        generation,
        profile,
        credentials,
        identity: provisionalIdentity,
        webrtc: provisionalWebrtc,
        status: "activating",
      });

      await this.commit(
        await this.composeState({
          status: "activating",
          generation,
          profile,
          hasCredentials: credentials !== null,
          identity: provisionalIdentity,
          webrtc: provisionalWebrtc,
          providerFailed: false,
        }),
        true,
      );

      if (this.generation !== generation) return this.state;
      const webrtc = await this.changeWebRtc(() => this.deps.webrtc.apply(profile.webrtcPolicy));
      if (this.generation !== generation) return this.state;

      await this.commit(
        await this.composeState({
          status: "resolving",
          generation,
          profile,
          hasCredentials: credentials !== null,
          identity: this.state.identity,
          webrtc,
          providerFailed: false,
        }),
        true,
      );

      if (this.generation !== generation) return this.state;
      const resolution = await this.resolveIdentity(profile, controller.signal);
      // Stale guard: a newer activation (or a deactivation) won the race.
      if (this.generation !== generation) return this.state;

      if (
        profile.identity.mode === "auto" &&
        profile.identity.geolocationPolicy !== "manual" &&
        profile.identity.timezonePolicy !== "manual" &&
        !resolution.providerFailed
      ) {
        await this.persistResolvedIdentity(profile, resolution.identity, generation);
      }

      if (this.generation !== generation) return this.state;
      const probed = await this.deps.probeContent(generation);
      if (this.generation !== generation) return this.state;
      this.activeTabId = probed.activeTabId;
      for (const frame of probed.frames) {
        this.diagnostics = recordContentDiagnostic(this.diagnostics, frame);
      }
      const content = summarizeContentDiagnostics(
        this.diagnostics,
        generation,
        resolution.identity.timezone,
        this.activeTabId,
      );

      await this.saveSnapshot({
        generation,
        profile,
        credentials,
        identity: resolution.identity,
        webrtc,
        status: "ready",
      });

      const lastError: RuntimeErrorInfo | undefined = resolution.consentBlocked
        ? {
            code: "consent_required",
            message: resolution.providerError ?? "GeoIP consent is required.",
          }
        : resolution.providerFailed && resolution.providerError !== undefined
          ? { code: "provider_error", message: resolution.providerError }
          : undefined;

      return await this.commit(
        await this.composeState({
          status: "ready",
          generation,
          profile,
          hasCredentials: credentials !== null,
          identity: resolution.identity,
          webrtc,
          providerFailed: resolution.providerFailed,
          content,
          ...(lastError === undefined ? {} : { lastError }),
        }),
        false,
      );
    } catch (error) {
      if (this.generation !== generation) return this.state;
      return await this.failWith(
        "activation_failed",
        describeError(error, "Profile activation failed."),
      );
    }
  }

  /** Re-resolves the active profile (user pressed "Refresh Identity"). */
  async refresh(): Promise<RuntimeState> {
    const profileId = this.state.activeProfileId;
    if (profileId === null) return this.state;
    return this.appliedProfile === null
      ? this.activate(profileId)
      : this.activate(profileId, {
          profile: this.appliedProfile,
          credentials: this.target?.credentials ?? null,
        });
  }

  /** Clears routing, relinquishes the WebRTC override and stops spoofing. */
  async deactivate(): Promise<RuntimeState> {
    this.deactivating = true;
    const generation = ++this.generation;
    try {
      this.abortController?.abort();
      this.abortController = null;
      this.target = null;
      this.appliedProfile = null;
      this.snapshotRestore = "absent";
      this.diagnostics = [];
      this.activeTabId = null;
      this.content = { ...EMPTY_CONTENT_STATE };
      await this.deps.targets.clear();
      await mutateProfiles(this.deps.profiles, (current) =>
        generation === this.generation
          ? setActiveProfile(current, null)
          : { ok: true, value: current },
      );
      if (this.generation !== generation) return this.state;
      const webrtc = await this.changeWebRtc(() => this.deps.webrtc.release());
      if (this.generation !== generation) return this.state;
      return await this.commit(
        await this.composeState({
          status: "idle",
          generation,
          profile: null,
          hasCredentials: false,
          identity: { source: "auto", publicIpVerified: false },
          webrtc,
          providerFailed: false,
          content: { ...EMPTY_CONTENT_STATE },
        }),
        false,
      );
    } catch (error) {
      if (this.generation !== generation) return this.state;
      return await this.failWith(
        "deactivate_failed",
        describeError(error, "Could not deactivate the profile."),
      );
    } finally {
      if (this.generation === generation) this.deactivating = false;
    }
  }

  /** `proxy.onError`: surfaced in the UI, never containing credentials. */
  recordProxyError(error: unknown): void {
    const message = describeError(error, "The proxy reported an error.");
    void this.recordDiagnostic("proxy_error", message);
  }

  /**
   * Page shim self-report. Untrusted by definition (a page can forge it) and used
   * only for the staleness diagnostic, never to change identity state.
   */
  recordContentReport(report: PageAppliedReport, place: { tabId: number; frameId: number }): void {
    this.diagnostics = recordContentDiagnostic(this.diagnostics, {
      tabId: place.tabId,
      frameId: place.frameId,
      generation: report.generation,
      timezone: report.timezone,
      updatedAt: this.deps.now(),
    });
    this.replaceContent(this.snapshotContent(this.state.identity.timezone));
  }

  /**
   * Re-reads Firefox proxy and WebRTC settings and broadcasts the audit.
   * Does not activate a profile, change generation, or write either setting.
   */
  async refreshObservedSettings(): Promise<RuntimeState> {
    // A setting `onChange` fires while `deactivate()` is releasing WebRTC control.
    // Reading the state then would see a profile-less state that still carries the
    // old identity coordinates and would re-publish them to pages. Wait for the
    // transition to commit its idle state instead.
    if (!this.initialized || this.isBusy() || this.deactivating) return this.state;
    const read = await this.deps.webrtc.read();
    const webrtc = describeObservedWebRtc(this.state.webrtc.desired, read);
    const state = await this.composeState({
      status: this.state.status,
      generation: this.state.generation,
      profile: this.currentProfileForCompose(),
      hasCredentials: this.state.proxy.hasCredentials,
      identity: this.state.identity,
      webrtc,
      providerFailed: this.state.lastError?.code === "provider_error",
      content: this.content,
      ...(this.state.lastError === undefined ? {} : { lastError: this.state.lastError }),
    });
    const unchanged =
      state.firefoxProxy.proxyType === this.state.firefoxProxy.proxyType &&
      state.firefoxProxy.levelOfControl === this.state.firefoxProxy.levelOfControl &&
      state.webrtc.status === this.state.webrtc.status &&
      state.webrtc.actual === this.state.webrtc.actual &&
      state.webrtc.levelOfControl === this.state.webrtc.levelOfControl;
    if (unchanged) return this.state;
    if (state.generation !== this.generation) return this.state;
    this.state = state;
    await this.deps.broadcastState(this.state);
    return this.state;
  }

  /** Drops every frame of a tab that Firefox has closed. */
  forgetContentTab(tabId: number): void {
    const next = forgetContentTab(this.diagnostics, tabId);
    if (next.length === this.diagnostics.length) return;
    this.diagnostics = next;
    if (this.activeTabId === tabId) this.activeTabId = null;
    this.replaceContent(this.snapshotContent(this.state.identity.timezone));
  }

  private snapshotContent(timezone: string | undefined): ContentRuntimeState {
    return summarizeContentDiagnostics(
      this.diagnostics,
      this.state.generation,
      timezone,
      this.activeTabId,
    );
  }

  private replaceContent(next: ContentRuntimeState): void {
    const unchanged =
      this.content.hasShim === next.hasShim &&
      this.content.reportedGeneration === next.reportedGeneration &&
      this.content.reportedTimezone === next.reportedTimezone &&
      this.content.frameCount === next.frameCount &&
      this.content.currentFrameCount === next.currentFrameCount &&
      this.content.activeTabCurrent === next.activeTabCurrent;
    this.content = next;
    if (!unchanged) void this.rebroadcast();
  }

  private async recordDiagnostic(code: string, message: string): Promise<void> {
    const generation = this.generation;
    const state = await this.composeState({
      status: this.state.status,
      generation,
      profile: this.currentProfileForCompose(),
      hasCredentials: this.state.proxy.hasCredentials,
      identity:
        this.target === null ? { source: "auto", publicIpVerified: false } : this.state.identity,
      webrtc: this.state.webrtc,
      providerFailed: this.state.lastError?.code === "provider_error",
      content: this.content,
      lastError: { code, message },
    });
    if (state.generation !== this.generation) return;
    this.state = state;
    await this.deps.broadcastState(this.state);
  }

  private async failWith(code: string, message: string): Promise<RuntimeState> {
    const state = await this.composeState({
      status: "error",
      generation: this.generation,
      profile: this.currentProfileForCompose(),
      hasCredentials: this.state.proxy.hasCredentials,
      identity: this.state.identity,
      webrtc: this.state.webrtc,
      providerFailed: false,
      content: this.content,
      lastError: { code, message },
    });
    await this.commit(state, false);
    return this.state;
  }

  private async commit(state: RuntimeState, pending: boolean): Promise<RuntimeState> {
    if (state.generation !== this.generation) return this.state;
    this.state = state;
    this.initialized = true;
    await this.deps.broadcastIdentity(this.buildEnvelope(pending || this.isBusy()));
    await this.deps.broadcastState(this.state);
    return this.state;
  }

  private async rebroadcast(): Promise<void> {
    const state = await this.composeState({
      status: this.state.status,
      generation: this.state.generation,
      profile: this.currentProfileForCompose(),
      hasCredentials: this.state.proxy.hasCredentials,
      identity: this.state.identity,
      webrtc: this.state.webrtc,
      providerFailed: this.state.lastError?.code === "provider_error",
      content: this.content,
      ...(this.state.lastError === undefined ? {} : { lastError: this.state.lastError }),
    });
    if (state.generation !== this.generation) return;
    this.state = state;
    await this.deps.broadcastState(state);
  }

  private async composeIdleState(
    generation: number,
    lastError?: RuntimeErrorInfo,
  ): Promise<RuntimeState> {
    return await this.composeState({
      status: "idle",
      generation,
      profile: null,
      hasCredentials: false,
      identity: { source: "auto", publicIpVerified: false },
      webrtc: createPendingWebRtcState("default"),
      providerFailed: false,
      content: { ...EMPTY_CONTENT_STATE },
      ...(lastError === undefined ? {} : { lastError }),
    });
  }

  /** Rebuilds the minimal profile needed for state composition from the live target. */
  private currentProfileForCompose(): IdentityProfile | null {
    const target = this.target;
    if (target === null) return null;
    return {
      id: target.profileId,
      name: target.profileName,
      proxy: target.proxy,
      identity: identityConfigFrom(this.state.identity),
      webrtcPolicy: this.state.webrtc.desired,
      revision: this.state.appliedRevision ?? 1,
    };
  }

  private async composeState(params: {
    status: RuntimeStatus;
    generation: number;
    profile: IdentityProfile | null;
    hasCredentials: boolean;
    identity: ResolvedIdentity;
    webrtc: WebRtcRuntimeState;
    providerFailed: boolean;
    content?: ContentRuntimeState;
    lastError?: RuntimeErrorInfo;
  }): Promise<RuntimeState> {
    const profile = params.profile;
    const content = params.content ?? this.content;
    const firefoxProxy = await this.deps.readFirefoxProxySettings();

    const proxy: ProxyRuntimeSummary =
      profile === null
        ? {
            configured: false,
            type: "direct",
            proxyDns: false,
            bypassCount: 0,
            hasCredentials: false,
          }
        : {
            configured: isProxied(profile.proxy),
            type: profile.proxy.type,
            ...(profile.proxy.host === undefined ? {} : { host: profile.proxy.host }),
            ...(profile.proxy.port === undefined ? {} : { port: profile.proxy.port }),
            proxyDns: profile.proxy.proxyDNS,
            bypassCount: profile.proxy.bypassHosts.length,
            hasCredentials: params.hasCredentials,
          };

    const audit = buildAuditReport({
      status: params.status,
      activeProfileId: profile === null ? null : profile.id,
      generation: params.generation,
      proxy,
      identity: params.identity,
      webrtc: params.webrtc,
      content,
      firefoxProxy,
      providerFailed: params.providerFailed,
    });

    return createRuntimeState({
      status: params.status,
      generation: params.generation,
      activeProfileId: profile === null ? null : profile.id,
      activeProfileName: profile === null ? null : profile.name,
      appliedRevision: profile === null ? 0 : (profile.revision ?? 1),
      proxy,
      identity: params.identity,
      webrtc: params.webrtc,
      firefoxProxy,
      content,
      audit,
      lastError: params.lastError,
      updatedAt: this.deps.now(),
    });
  }

  /**
   * Resolves the identity from the observed egress IP.
   *
   * The provider request travels through the active proxy because it is issued from
   * the background script and the GeoIP endpoint is never bypassed.
   */
  private async resolveIdentity(
    profile: IdentityProfile,
    signal: AbortSignal,
  ): Promise<IdentityResolution> {
    let geo: GeoIpResult | null = null;
    let providerFailed = false;
    let providerError: string | undefined;
    let consentBlocked = false;

    const consent = decideGeoIpConsent(
      profile.proxy.type,
      await this.deps.readDataCollection().catch(() => ({
        apiAvailable: false,
        optionalGranted: [],
      })),
    );
    if (signal.aborted)
      return {
        identity: { source: profile.identity.mode, publicIpVerified: false },
        providerFailed: false,
        providerError: undefined,
        consentBlocked: false,
      };
    if (profile.identity.geoIpPolicy === "disabled") {
      // Explicitly disabled: no request and no direct/native fallback.
    } else if (!consent.allowed) {
      consentBlocked = true;
      providerError = consent.message;
    } else {
      try {
        geo = await this.deps.provider.resolve(signal);
      } catch (error) {
        providerFailed = true;
        providerError = describeGeoIpFailure(error);
      }
    }

    const observedIp = geo === null ? undefined : geo.ip;

    if (signal.aborted) {
      return {
        identity: { source: profile.identity.mode, publicIpVerified: false },
        providerFailed,
        providerError,
        consentBlocked,
      };
    }

    const identity: ResolvedIdentity = {
      source: "auto",
      publicIpVerified: observedIp !== undefined,
    };
    if (observedIp !== undefined) {
      identity.publicIp = observedIp;
      identity.observedIp = observedIp;
    }
    if (geo !== null) {
      if (geo.countryCode !== undefined) identity.countryCode = geo.countryCode;
      if (geo.region !== undefined) identity.region = geo.region;
      if (geo.city !== undefined) identity.city = geo.city;
      if (geo.latitude !== undefined && geo.longitude !== undefined) {
        identity.latitude = geo.latitude;
        identity.longitude = geo.longitude;
        // GeoIP coordinates are approximate: never present them as precise.
        identity.accuracy = GEOIP_ACCURACY_METERS;
        identity.geoIpLocation = {
          latitude: geo.latitude,
          longitude: geo.longitude,
          accuracy: GEOIP_ACCURACY_METERS,
          ...(geo.timezone === undefined ? {} : { timezone: geo.timezone }),
        };
      }
      if (geo.timezone !== undefined) identity.timezone = geo.timezone;
      identity.provider = this.deps.provider.id;
    }
    const locationPolicy =
      profile.identity.geolocationPolicy ??
      (profile.identity.mode === "manual" ? "manual" : "follow");
    const timezonePolicy =
      profile.identity.timezonePolicy ?? (profile.identity.mode === "manual" ? "manual" : "follow");
    if (locationPolicy !== "follow") {
      delete identity.latitude;
      delete identity.longitude;
      delete identity.accuracy;
      if (locationPolicy === "manual") {
        if (profile.identity.latitude !== undefined) identity.latitude = profile.identity.latitude;
        if (profile.identity.longitude !== undefined)
          identity.longitude = profile.identity.longitude;
        if (profile.identity.accuracy !== undefined) identity.accuracy = profile.identity.accuracy;
      }
    }
    if (timezonePolicy === "manual") {
      if (profile.identity.timezone !== undefined) identity.timezone = profile.identity.timezone;
    }
    if (locationPolicy === "manual" || timezonePolicy === "manual") identity.source = "manual";
    identity.resolvedAt = this.deps.now();
    return { identity, providerFailed, providerError, consentBlocked };
  }

  private async persistResolvedIdentity(
    profile: IdentityProfile,
    identity: ResolvedIdentity,
    generation: number,
  ): Promise<void> {
    if (isBuiltinDirectProfile(profile.id)) return;
    await mutateProfiles(this.deps.profiles, (current) => {
      const existing = findProfile(current, profile.id);
      if (
        existing === null ||
        generation !== this.generation ||
        existing.revision !== profile.revision
      )
        return { ok: true, value: current };
      return upsertProfile(current, {
        ...existing,
        identity: {
          ...identityConfigFrom({ ...identity, source: "auto" }),
          geoIpPolicy: existing.identity.geoIpPolicy ?? "automatic",
          providerId: "ipwho.is",
          geolocationPolicy: existing.identity.geolocationPolicy ?? "follow",
          timezonePolicy: existing.identity.timezonePolicy ?? "follow",
        },
      });
    });
  }

  private async saveSnapshot(params: {
    generation: number;
    profile: IdentityProfile;
    credentials: ActiveProxyTarget["credentials"];
    identity: ResolvedIdentity;
    webrtc: WebRtcRuntimeState;
    status: RuntimeStatus;
  }): Promise<void> {
    if (params.generation !== this.generation) return;
    const snapshot: ActiveTargetSnapshot = {
      schemaVersion: ACTIVE_TARGET_SCHEMA_VERSION,
      generation: params.generation,
      profileId: params.profile.id,
      profile: params.profile,
      profileName: params.profile.name,
      appliedRevision: params.profile.revision ?? 1,
      proxy: params.profile.proxy,
      credentials: params.credentials,
      webrtcPolicy: params.profile.webrtcPolicy,
      identity: params.identity,
      webrtc: params.webrtc,
      status: params.status,
      updatedAt: this.deps.now(),
    };
    await this.deps.targets.save(snapshot);
  }
}
