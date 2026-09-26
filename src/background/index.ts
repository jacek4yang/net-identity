/**
 * Background entry point: the only file that wires the Firefox APIs to the
 * testable modules.
 *
 * Firefox Manifest V3 uses an event page (`background.scripts` + `type: module`),
 * not a service worker. The page may be suspended while the browser stays open, so:
 *   - listeners are registered at the top level, as Firefox requires
 *   - the active routing target is mirrored into `storage.session`
 *     (see `active-target.ts`), so proxy decisions survive a restart of this page
 *   - `initialize()` runs on every start and either restores that snapshot or
 *     performs a full activation
 *
 * Secrets: proxy passwords reach this file only through `credentialStore`, which is
 * bound to `browser.storage.session`. Nothing here logs credentials.
 */
import { MAX_DISTINCT_TABS_TO_PROBE } from "../shared/constants";
import { parseProbeResponse } from "../shared/messages";
import type { IdentityEnvelope } from "../shared/public-identity";
import { describeError } from "../shared/result";
import { fromBrowserStorageArea } from "../shared/storage";
import type { ContentRuntimeState, RuntimeState } from "../shared/state";
import { createDefaultGeoIpProvider } from "../geo/ipwhois";
import { createProfileStore, mutateProfiles, upsertProfile } from "../profile/store";
import { createActiveTargetStore } from "./active-target";
import { createCredentialStore } from "./credentials";
import { ActivationController } from "./identity";
import { createDefaultProfile, createMessageHandler, type SenderInfo } from "./messages";
import { readFirefoxProxySettings } from "./proxy";
import {
  createUnavailableWebRtcController,
  createWebRtcController,
  type WebRtcController,
  type WebRtcSettingLike,
} from "./webrtc";

const now = (): number => Date.now();

const profileStore = createProfileStore(fromBrowserStorageArea(browser.storage.local));
const sessionArea = fromBrowserStorageArea(browser.storage.session);
const credentialStore = createCredentialStore(sessionArea);
const targetStore = createActiveTargetStore(sessionArea);
const geoProvider = createDefaultGeoIpProvider();

/** Resolves the privacy setting, degrading gracefully on unusual builds. */
function createWebRtc(): WebRtcController {
  let setting: WebRtcSettingLike | null = null;
  try {
    setting = browser.privacy.network.webRTCIPHandlingPolicy;
  } catch {
    // Builds without the privacy API stay on the unavailable controller below.
  }
  if (setting === null || setting === undefined) {
    return createUnavailableWebRtcController(
      "This Firefox build does not expose privacy.network.webRTCIPHandlingPolicy.",
    );
  }
  return createWebRtcController(setting);
}

const webrtc = createWebRtc();

async function broadcastState(state: RuntimeState): Promise<void> {
  try {
    await browser.runtime.sendMessage({ type: "state:changed", state });
  } catch {
    // No popup or options page is open. This is the common case, not an error.
  }
}

async function listHttpTabs(): Promise<browser.tabs.Tab[]> {
  try {
    // Filtering by URL requires the <all_urls> host permission, which this
    // extension already needs for proxy.onRequest interception.
    return await browser.tabs.query({ url: ["http://*/*", "https://*/*"] });
  } catch {
    return [];
  }
}

async function broadcastIdentity(envelope: IdentityEnvelope): Promise<void> {
  const tabs = await listHttpTabs();
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await browser.tabs.sendMessage(tab.id, { type: "identity:update", envelope });
      } catch {
        // No bridge in that tab (for example a page still loading).
      }
    }),
  );
}

/**
 * Asks open tabs which identity their page shim actually applied.
 *
 * Page reports are untrusted diagnostics: they are used to detect stale injections
 * and are never treated as identity data.
 */
async function probeContent(generation: number): Promise<ContentRuntimeState> {
  const tabs = (await listHttpTabs()).slice(0, MAX_DISTINCT_TABS_TO_PROBE);
  const responses = await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return null;
      try {
        const response: unknown = await browser.tabs.sendMessage(tab.id, { type: "content:probe" });
        const parsed = parseProbeResponse(response);
        return parsed.ok ? parsed.value : null;
      } catch {
        return null;
      }
    }),
  );

  const reports = responses.filter(
    (report): report is NonNullable<typeof report> => report !== null,
  );
  if (reports.length === 0) return { hasShim: false, reportedGeneration: null };

  const current = reports.find((report) => report.generation === generation);
  const newest = reports.reduce((best, report) =>
    report.generation > best.generation ? report : best,
  );
  const chosen = current ?? newest;

  return {
    hasShim: chosen.hasShim,
    reportedGeneration: chosen.generation,
    ...(chosen.timezone === null ? {} : { reportedTimezone: chosen.timezone }),
    ...(chosen.url === "" ? {} : { url: chosen.url }),
  };
}

const controller = new ActivationController({
  profiles: profileStore,
  credentials: credentialStore,
  targets: targetStore,
  webrtc,
  provider: geoProvider,
  readFirefoxProxySettings: () => readFirefoxProxySettings(browser.proxy.settings),
  broadcastState,
  broadcastIdentity,
  probeContent,
  now,
});

/* ------------------------------------------------------------------ listeners */

// Dynamic proxy decisions. Firefox explicitly allows this listener to return a
// Promise resolving to ProxyInfo (the session-snapshot fallback depends on that),
// which the bundled `void`-returning callback type cannot express.
// `<all_urls>` includes http(s) and ws(s). `decideProxy` then routes those four
// schemes and leaves internal URLs direct; narrowing the filter would let a
// WebSocket bypass the active profile.
// eslint-disable-next-line @typescript-eslint/no-misused-promises
browser.proxy.onRequest.addListener((details) => controller.decideProxyForRequest(details.url), {
  urls: ["<all_urls>"],
});

browser.proxy.onError.addListener((error) => {
  controller.recordProxyError(error);
});

/**
 * Challenge-based proxy authentication (HTTP/HTTPS proxies only; Firefox never
 * calls this for SOCKS). Strict matching happens in `decideProxyAuth`, so origin
 * `WWW-Authenticate` challenges can never receive proxy credentials.
 */
browser.webRequest.onAuthRequired.addListener(
  (details) => {
    const credentials = controller.decideProxyAuth({
      isProxy: details.isProxy === true,
      challengerHost: details.challenger?.host,
      challengerPort: details.challenger?.port,
    });
    if (credentials === null) return undefined;
    return { authCredentials: credentials };
  },
  { urls: ["<all_urls>"] },
  ["blocking"],
);

const handleMessage = createMessageHandler({
  profiles: profileStore,
  credentials: credentialStore,
  controller,
  runtimeId: browser.runtime.id,
});

browser.runtime.onMessage.addListener((message: unknown, sender) => {
  const info: SenderInfo = {
    id: sender.id,
    fromContentScript: sender.tab !== undefined,
    url: sender.url,
  };
  return handleMessage(message, info);
});

browser.runtime.onInstalled.addListener((details) => {
  void (async () => {
    try {
      if (details.reason !== "install") return;
      const stored = await profileStore.load();
      if (stored.profiles.length > 0) return;
      const profile = createDefaultProfile();
      const saved = await mutateProfiles(profileStore, (current) =>
        upsertProfile(current, profile),
      );
      if (saved.ok) await controller.activate(profile.id);
    } catch (error) {
      console.error("[net-identity] first-run setup failed:", describeError(error));
    }
  })();
});

browser.runtime.onStartup.addListener(() => {
  void controller.initialize();
});

// Restore or re-establish the active identity whenever this event page starts.
void controller.initialize();
