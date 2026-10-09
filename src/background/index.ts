import { VaultStore } from "../vault/store";
import { createVaultHandler } from "../vault/messages";
import { DraftProbeBroker } from "./draft-probe";
import { parseDraftRequest } from "../shared/draft-probe";
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
import type { ContentDiagnostic, ContentProbeResult } from "../shared/content-diagnostics";
import { MAX_DISTINCT_TABS_TO_PROBE } from "../shared/constants";
import { parseProbeResponse } from "../shared/messages";
import type { IdentityEnvelope } from "../shared/public-identity";
import { fromBrowserStorageArea } from "../shared/storage";
import type { RuntimeState } from "../shared/state";
import { createDefaultGeoIpProvider } from "../geo/ipwhois";
import { createProfileStore } from "../profile/store";
import { createActiveTargetStore } from "./active-target";
import { createCredentialStore } from "./credentials";
import { MapResourceBroker } from "./map-broker";
import { MAP_ORIGIN, parseMapRequest } from "../shared/map-provider";
import { isPlainObject } from "../shared/result";
import { ActivationController } from "./identity";
import { createMessageHandler, type SenderInfo } from "./messages";
import { createAuthAttemptTracker, readFirefoxProxySettings } from "./proxy";
import {
  createUnavailableWebRtcController,
  createWebRtcController,
  isOwnWebRtcEcho,
  type WebRtcSettingLike,
} from "./webrtc";

const now = (): number => Date.now();

const vault = new VaultStore(
  fromBrowserStorageArea(browser.storage.local),
  fromBrowserStorageArea(browser.storage.session),
);
const profileStore = createProfileStore(vault.profiles);
const sessionArea = vault.secrets;
const credentialStore = createCredentialStore(sessionArea);
const targetStore = createActiveTargetStore(sessionArea);
const geoProvider = createDefaultGeoIpProvider();
const draftBroker = new DraftProbeBroker({
  extensionUrl: browser.runtime.getURL(""),
  consent: async () => {
    try {
      return Array.isArray((await browser.permissions.getAll()).data_collection);
    } catch {
      return false;
    }
  },
  credentials: async (id, proxy) => {
    const saved = (await profileStore.load()).profiles.find((profile) => profile.id === id);
    // Never send a saved secret to a newly typed server. Re-enter credentials to
    // authorize that new endpoint; unchanged endpoints can reuse this session.
    if (
      !saved ||
      saved.proxy.type !== proxy.type ||
      saved.proxy.host !== proxy.host ||
      saved.proxy.port !== proxy.port
    )
      return null;
    return credentialStore.get(id);
  },
  fetch: (url, init) => fetch(url, init),
  newId: () => crypto.randomUUID(),
});

/** Resolves the privacy setting, degrading gracefully on unusual builds. */
const webrtcSetting = readWebRtcSetting();
const webrtc =
  webrtcSetting === null
    ? createUnavailableWebRtcController(
        "This Firefox build does not expose privacy.network.webRTCIPHandlingPolicy.",
      )
    : createWebRtcController(webrtcSetting);

function readWebRtcSetting(): WebRtcSettingLike | null {
  try {
    const setting = browser.privacy.network.webRTCIPHandlingPolicy;
    return setting ?? null;
  } catch {
    return null;
  }
}

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
  // Tab enumeration may finish after a newer route/Off committed.
  if (JSON.stringify(envelope) !== JSON.stringify(controller.getEnvelope())) return;
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
async function probeContent(_generation: number): Promise<ContentProbeResult> {
  const tabs = (await listHttpTabs()).slice(0, MAX_DISTINCT_TABS_TO_PROBE);
  const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
  const activeTabId = activeTabs[0]?.id ?? null;
  const frames: ContentDiagnostic[] = [];
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        const response: unknown = await browser.tabs.sendMessage(tab.id, {
          type: "content:probe",
        });
        const parsed = parseProbeResponse(response);
        if (!parsed.ok || !parsed.value.hasShim) return;
        frames.push({
          tabId: tab.id,
          frameId: 0,
          generation: parsed.value.generation,
          timezone: parsed.value.timezone,
          updatedAt: Date.now(),
        });
      } catch {
        // No bridge in that tab yet.
      }
    }),
  );
  return { frames, activeTabId };
}

const controller = new ActivationController({
  beforeRouteChange: () => mapBroker?.invalidate(),
  profiles: profileStore,
  credentials: credentialStore,
  targets: targetStore,
  webrtc,
  provider: geoProvider,
  readFirefoxProxySettings: () => readFirefoxProxySettings(browser.proxy.settings),
  broadcastState,
  broadcastIdentity,
  probeContent,
  readDataCollection: async () => {
    try {
      const granted = await browser.permissions.getAll();
      const optional = granted.data_collection;
      if (!Array.isArray(optional)) return { apiAvailable: false, optionalGranted: [] };
      return { apiAvailable: true, optionalGranted: optional };
    } catch {
      return { apiAvailable: false, optionalGranted: [] };
    }
  },
  now,
});

const mapBroker = new MapResourceBroker({
  state: () => controller.getState(),
  generation: () => controller.getGeneration(),
  target: () => controller.getTarget(),
  collection: async () => {
    const grants = await browser.permissions.getAll();
    return {
      apiAvailable: Array.isArray(grants.data_collection),
      optionalGranted: grants.data_collection ?? [],
    };
  },
  fetch: (input, init) => fetch(input, init),
  newId: () => crypto.randomUUID(),
});
browser.permissions.onRemoved.addListener(() => mapBroker?.invalidate());

subscribeToSettingChanges();

/**
 * Firefox can change proxy or WebRTC control after activation. Re-read the
 * audit only. Writing the setting again would loop on our own `onChange`.
 */
function subscribeToSettingChanges(): void {
  addSettingListener(browser.proxy.settings, () => {
    void controller.refreshObservedSettings();
  });
  if (webrtcSetting !== null) {
    addSettingListener(webrtcSetting, (details) => {
      if (isOwnWebRtcEcho(controller.getState().webrtc, details)) return;
      void controller.refreshObservedSettings();
    });
  }
}

function addSettingListener(
  setting: object,
  listener: (details: { value: unknown; levelOfControl?: string }) => void,
): void {
  if (!("onChange" in setting)) return;
  const onChange = setting.onChange;
  if (typeof onChange !== "object" || onChange === null || !("addListener" in onChange)) return;
  const addListener = onChange.addListener;
  if (typeof addListener !== "function") return;
  addListener.call(onChange, listener);
}

/* ------------------------------------------------------------------ listeners */

// Dynamic proxy decisions. Firefox explicitly allows this listener to return a
// Promise resolving to ProxyInfo (the session-snapshot fallback depends on that),
// which the bundled `void`-returning callback type cannot express.
// `<all_urls>` includes http(s) and ws(s). `decideProxy` then routes those four
// schemes and leaves internal URLs direct; narrowing the filter would let a
// WebSocket bypass the active profile.
browser.proxy.onRequest.addListener(
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  (details) =>
    draftBroker.isProbe(details.url)
      ? draftBroker.route(details)
      : controller.decideProxyForRequest(details.url, details.requestId),
  {
    urls: ["<all_urls>"],
  },
);

// ProxyInfo has no "block" value. Cancel requests whose durable route cannot
// be reconstructed; a proxy.onRequest error must never become a direct request.
browser.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (draftBroker.isProbe(details.url)) return { cancel: !draftBroker.allows(details) };
    if (await controller.shouldBlockRequest(details.url)) return { cancel: true };
    // proxy.onRequest (including its cooldown) runs before webRequest. Recheck
    // the ephemeral generation after that decision, never permit stale map work.
    const ownRequest = [details.originUrl, details.documentUrl].some(
      (url) => url?.startsWith(browser.runtime.getURL("")) === true,
    );
    if (ownRequest && details.url.startsWith(`${MAP_ORIGIN}/`))
      return { cancel: mapBroker?.allowsNetwork(details.url) !== true };
    return { cancel: false };
  },
  { urls: ["<all_urls>"] },
  ["blocking"],
);

browser.proxy.onError.addListener((error) => {
  void controller.recordProxyError(error);
});

/**
 * Challenge-based proxy authentication (HTTP/HTTPS proxies only; Firefox never
 * calls this for SOCKS). Strict host-and-port matching happens in
 * `decideProxyAuth`. Each request id is answered at most once so a rejected
 * password is not replayed in a 407 loop.
 */
const proxyAuthAttempts = createAuthAttemptTracker();

browser.webRequest.onAuthRequired.addListener(
  (details) => {
    if (draftBroker.isProbe(details.url)) {
      const credentials = draftBroker.auth(details, {
        isProxy: details.isProxy === true,
        challengerHost: details.challenger?.host,
        challengerPort: details.challenger?.port,
      });
      return credentials === null ? { cancel: true } : { authCredentials: credentials };
    }
    const requestId = details.requestId;
    if (typeof requestId !== "string" || !proxyAuthAttempts.claim(requestId)) return undefined;
    const credentials = controller.decideProxyAuth({
      isProxy: details.isProxy === true,
      challengerHost: details.challenger?.host,
      challengerPort: details.challenger?.port,
    });
    if (credentials === null) {
      proxyAuthAttempts.release(requestId);
      return undefined;
    }
    return { authCredentials: credentials };
  },
  { urls: ["<all_urls>"] },
  ["blocking"],
);

function releaseProxyAuthAttempt(details: { requestId: string }): void {
  proxyAuthAttempts.release(details.requestId);
}

browser.webRequest.onCompleted.addListener(releaseProxyAuthAttempt, { urls: ["<all_urls>"] });
browser.webRequest.onErrorOccurred.addListener(releaseProxyAuthAttempt, { urls: ["<all_urls>"] });
browser.webRequest.onCompleted.addListener(
  (details) => {
    if (!draftBroker.isProbe(details.url)) controller.recordNetworkSuccess(details);
  },
  { urls: ["<all_urls>"] },
);
browser.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (!draftBroker.isProbe(details.url)) controller.recordNetworkFailure(details);
  },
  { urls: ["<all_urls>"] },
);

let startup = controller.initialize();
const handleMessage = createMessageHandler({
  profiles: profileStore,
  credentials: credentialStore,
  controller,
  runtimeId: browser.runtime.id,
  startupReady: () => startup,
});

const handleVault = createVaultHandler(vault, async () => {
  await startup;
  startup = controller.initialize();
  await startup;
});

browser.runtime.onMessage.addListener((message: unknown, sender) => {
  if (
    isPlainObject(message) &&
    typeof message.type === "string" &&
    message.type.startsWith("vault:")
  ) {
    if (
      sender.id !== browser.runtime.id ||
      !["options/options.html", "popup/popup.html"].some(
        (path) => sender.url === browser.runtime.getURL(path),
      )
    )
      return undefined;
    return handleVault(message);
  }
  if (
    isPlainObject(message) &&
    typeof message.type === "string" &&
    message.type.startsWith("draft:")
  ) {
    if (
      sender.id !== browser.runtime.id ||
      !["options/options.html", "popup/popup.html"].some(
        (path) => sender.url === browser.runtime.getURL(path),
      )
    )
      return undefined;
    const parsed = parseDraftRequest(message);
    if (!parsed.ok) return Promise.resolve({ ok: false, error: "invalid" });
    const owner = `${sender.url}:${sender.tab?.id ?? "popup"}:${parsed.value.owner}`;
    if (parsed.value.type === "draft:cancel") {
      draftBroker.cancel(owner);
      return Promise.resolve({ ok: false, error: "cancelled" });
    }
    return draftBroker.probe(owner, parsed.value.input);
  }

  if (
    isPlainObject(message) &&
    typeof message.type === "string" &&
    message.type.startsWith("map:")
  ) {
    if (
      sender.id !== browser.runtime.id ||
      sender.url !== browser.runtime.getURL("options/options.html")
    )
      return undefined;
    const parsed = parseMapRequest(message);
    if (!parsed.ok) return Promise.resolve({ ok: false, error: "Invalid map request." });
    return mapBroker?.handle(parsed.value, String(sender.tab?.id ?? "options"));
  }
  const info: SenderInfo = {
    id: sender.id,
    fromContentScript: sender.tab !== undefined,
    url: sender.url,
    ...(sender.tab?.id === undefined ? {} : { tabId: sender.tab.id }),
    ...(sender.frameId === undefined ? {} : { frameId: sender.frameId }),
  };
  return handleMessage(message, info);
});

browser.runtime.onStartup.addListener(() => {
  startup = controller.initialize();
});

browser.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url !== undefined) mapBroker.closeOwner(String(tabId));
});

browser.tabs.onRemoved.addListener((tabId) => {
  controller.forgetContentTab(tabId);
  mapBroker?.closeOwner(String(tabId));
});

// The startup promise also keeps state:get from reporting Off during restoration.
