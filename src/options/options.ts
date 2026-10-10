import { bindVaultControls } from "../shared/vault-ui";
import { bindDraftCheck } from "../shared/draft-check";
import { parseDraftRequest } from "../shared/draft-probe";
import { bindLanguageControl } from "../shared/language-control";
import { localizeKnownText as lt, message, formatMessage } from "../shared/i18n";
/**
 * Options page: profile CRUD and management.
 *
 * The DOM layer stays thin: field values are turned into a candidate profile by
 * `form.ts` (pure, unit tested) and validated by the same `parseProfile` used by
 * the background script, so the UI cannot save something the background would
 * reject.
 *
 * Credentials: the password travels from this page to the background script over
 * `runtime.sendMessage` only. It stays in the current editor after Save so a later activation or
 * correction cannot silently replace it with an empty value.
 */
import { BUILTIN_DIRECT_PROFILE_ID, describeProxy, type IdentityProfile } from "../profile/schema";
import { GUIDE } from "../shared/onboarding";
import { createProfileId } from "../profile/store";
import { parseProfile } from "../profile/validation";
import { clear, el, formatAccuracy, formatCoordinates, requireElement } from "../shared/dom";
import {
  parseMutationResponse,
  parseOutboundMessage,
  parseProfilesResponse,
  parseStateResponse,
  type ProfilesResponse,
} from "../shared/messages";
import {
  ensureDirectIpConsent,
  onRuntimeMessage,
  request,
  readMapAutoload,
  writeMapAutoload,
} from "../shared/runtime";
import type { RuntimeState } from "../shared/state";
import {
  accuracyRadiusPixels,
  applyResolvedLocation,
  seedBlankManualFields,
  viewportPoint,
  zoomToFitAccuracy,
  type LocationSeed,
  type MapViewport,
} from "./location-map";
import { locationTimezoneWarning } from "./identity-warning";
import { LocationMapModel } from "./map-model";
import { NO_TILES } from "./tile-provider";
import { createOnlineMap, type OnlineMap } from "./online-map";
import { parseMapResponse } from "../shared/map-provider";
import {
  credentialsIntentFrom,
  proxyFieldHints,
  toFormValues,
  toProfileInput,
  type ProfileFormValues,
} from "./form";

const guideBody = requireElement<HTMLElement>("#guide-body");
function renderGuide(): void {
  clear(guideBody);
  for (const section of GUIDE) {
    guideBody.append(
      el("h3", { text: lt(section.title) }),
      el("p", { className: "hint", text: lt(section.body) }),
    );
  }
}

const ui = {
  list: requireElement<HTMLUListElement>("#profile-list"),
  listEmpty: requireElement<HTMLElement>("#list-empty"),
  newProfile: requireElement<HTMLButtonElement>("#new-profile"),
  directView: requireElement<HTMLElement>("#direct-view"),
  directActiveBadge: requireElement<HTMLElement>("#direct-active-badge"),
  directActivate: requireElement<HTMLButtonElement>("#direct-activate"),
  directDeactivate: requireElement<HTMLButtonElement>("#direct-deactivate"),
  form: requireElement<HTMLFormElement>("#profile-form"),
  formTitle: requireElement<HTMLElement>("#form-title"),
  formBadge: requireElement<HTMLElement>("#form-badge"),
  errors: requireElement<HTMLElement>("#form-errors"),
  hints: requireElement<HTMLUListElement>("#hints"),
  name: requireElement<HTMLInputElement>("#field-name"),
  proxyType: requireElement<HTMLSelectElement>("#field-proxy-type"),
  proxyAddressFields: requireElement<HTMLElement>("#proxy-address-fields"),
  proxyHost: requireElement<HTMLInputElement>("#field-proxy-host"),
  proxyPort: requireElement<HTMLInputElement>("#field-proxy-port"),
  proxyUsername: requireElement<HTMLInputElement>("#field-proxy-username"),
  password: requireElement<HTMLInputElement>("#field-password"),
  removeCredentials: requireElement<HTMLInputElement>("#field-remove-credentials"),
  removeCredentialsRow: requireElement<HTMLElement>("#remove-credentials-row"),
  proxyDns: requireElement<HTMLInputElement>("#field-proxy-dns"),
  bypass: requireElement<HTMLTextAreaElement>("#field-bypass"),
  policyFields: requireElement<HTMLElement>("#identity-policies"),
  geoIpPolicy: requireElement<HTMLSelectElement>("#field-geoip-policy"),
  geolocationPolicy: requireElement<HTMLSelectElement>("#field-geolocation-policy"),
  timezonePolicy: requireElement<HTMLSelectElement>("#field-timezone-policy"),
  identityWarning: requireElement<HTMLElement>("#identity-warning"),
  saveStatus: requireElement<HTMLElement>("#save-status"),
  modeAuto: requireElement<HTMLInputElement>("#field-mode-auto"),
  modeManual: requireElement<HTMLInputElement>("#field-mode-manual"),
  manualFields: requireElement<HTMLElement>("#manual-fields"),
  mapSurface: requireElement<HTMLElement>("#location-map-surface"),
  mapTiles: requireElement<HTMLElement>("#location-map-tiles"),
  mapAccuracy: requireElement<HTMLElement>("#location-map-accuracy"),
  mapMarker: requireElement<HTMLElement>("#location-map-marker"),
  mapZoomIn: requireElement<HTMLButtonElement>("#map-zoom-in"),
  mapZoomOut: requireElement<HTMLButtonElement>("#map-zoom-out"),
  mapNotice: requireElement<HTMLElement>("#location-map-notice"),
  useGeoIpLocation: requireElement<HTMLButtonElement>("#use-geoip-location"),
  latitude: requireElement<HTMLInputElement>("#field-latitude"),
  longitude: requireElement<HTMLInputElement>("#field-longitude"),
  accuracy: requireElement<HTMLInputElement>("#field-accuracy"),
  timezone: requireElement<HTMLInputElement>("#field-timezone"),
  webrtc: requireElement<HTMLSelectElement>("#field-webrtc"),
  save: requireElement<HTMLButtonElement>("#save"),
  saveActivate: requireElement<HTMLButtonElement>("#save-activate"),
  duplicate: requireElement<HTMLButtonElement>("#duplicate"),
  delete: requireElement<HTMLButtonElement>("#delete"),
  deactivate: requireElement<HTMLButtonElement>("#deactivate"),
  refreshIdentity: requireElement<HTMLButtonElement>("#refresh-identity"),
  status: requireElement<HTMLElement>("#options-status"),
};

let profiles: IdentityProfile[] = [];
let runtimeState: RuntimeState | null = null;
let activeProfileId: string | null = null;
let credentialProfileIds: string[] = [];
let selectedId: string | null = null;
// A late initial storage snapshot must never replace work begun in the editor.
let editorRevision = 0;
let selectionRevision = 0;
let manualUserEdited = false;
let resolvedSeed: LocationSeed | null = null;
let draftSeed: LocationSeed | null = null;

const credentialEndpointKey = () =>
  JSON.stringify([ui.proxyType.value, ui.proxyHost.value.trim().toLowerCase(), ui.proxyPort.value]);
let credentialEndpoint: string | null = null;
for (const field of [ui.proxyUsername, ui.password])
  field.addEventListener("input", () => {
    credentialEndpoint = credentialEndpointKey();
  });

const draftCheck = bindDraftCheck({
  fields: [
    ui.proxyType,
    ui.proxyHost,
    ui.proxyPort,
    ui.proxyUsername,
    ui.password,
    ui.removeCredentials,
    ui.proxyDns,
    ui.geoIpPolicy,
  ],
  status: requireElement<HTMLElement>("#draft-status"),
  retry: requireElement<HTMLButtonElement>("#draft-retry"),
  disabled: () => ui.geoIpPolicy.value === "disabled",
  read: () => {
    if (ui.form.hidden || ui.geoIpPolicy.value === "disabled") return null;
    const values = readForm();
    const intent = credentialsIntentFrom(values);
    const proxy = {
      type: values.proxyType,
      host: values.proxyHost,
      port: Number(values.proxyPort),
      proxyDNS: values.proxyDns,
      bypassHosts: [],
      authenticationRequired:
        !values.removeCredentials && selectedProfile()?.proxy.authenticationRequired === true,
    };
    if (
      intent.action === "set" &&
      credentialEndpoint !== null &&
      credentialEndpoint !== credentialEndpointKey()
    ) {
      // Retaining the editor must not send an earlier endpoint's secret to a newly typed host.
      const blocked = parseDraftRequest({
        type: "draft:probe",
        owner: "ui-draft-validation",
        input: { proxy: { ...proxy, authenticationRequired: true }, credentials: null },
      });
      return blocked.ok && blocked.value.type === "draft:probe" ? blocked.value.input : null;
    }
    const parsed = parseDraftRequest({
      type: "draft:probe",
      owner: "ui-draft-validation",
      input: {
        proxy,
        ...(selectedId ? { profileId: selectedId } : {}),
        ...(intent.action === "clear"
          ? { credentials: null }
          : intent.action === "set"
            ? { credentials: { username: intent.username, password: intent.password } }
            : {}),
      },
    });
    return parsed.ok && parsed.value.type === "draft:probe" ? parsed.value.input : null;
  },
  invalidated: () => {
    draftSeed = null;
    resolvedSeed = null;
    if (!ui.form.hidden && ui.modeAuto.checked) {
      if (ui.geolocationPolicy.value === "follow") {
        ui.latitude.value = "";
        ui.longitude.value = "";
        syncMapSelection(true);
        renderLocationMap();
      }
      if (ui.timezonePolicy.value === "follow") ui.timezone.value = "";
    }
  },
  resolved: (identity) => {
    draftSeed = { ...identity, accuracy: 20000 };
    resolvedSeed = draftSeed;
    if (ui.modeAuto.checked && ui.timezonePolicy.value === "follow")
      ui.timezone.value = identity.timezone ?? "";
    // A preview must never overwrite the user's manual location or policies.
    if (ui.modeAuto.checked && ui.geolocationPolicy.value === "follow") {
      ui.latitude.value = identity.latitude === undefined ? "" : String(identity.latitude);
      ui.longitude.value = identity.longitude === undefined ? "" : String(identity.longitude);
      ui.accuracy.value = "20000";
      syncMapSelection(true);
      renderLocationMap();
    }
  },
});

const map = new LocationMapModel();
let onlineMap: OnlineMap | null = null;
let mapSessionId: string | null = null;
let onlineGeneration: number | null = null;
let mapLoadEpoch = 0;
const mapAutoload = requireElement<HTMLInputElement>("#map-autoload");
let mapPreferenceVersion = 0;
let mapPreferenceWrites: Promise<void> = Promise.resolve();
function rememberMapAutoload(enabled: boolean): void {
  const version = ++mapPreferenceVersion;
  mapAutoload.checked = enabled;
  mapPreferenceWrites = mapPreferenceWrites
    .then(() => writeMapAutoload(enabled))
    .catch(() => {
      if (version !== mapPreferenceVersion) return;
      mapAutoload.checked = false;
      setMapStatus("Could not save automatic map preference. Enable the map again next time.");
    });
}

const mapLoad = requireElement<HTMLButtonElement>("#load-online-map");
const mapUnload = requireElement<HTMLButtonElement>("#unload-online-map");
const mapOnlineStatus = requireElement<HTMLElement>("#map-online-status");
const mapAttribution = requireElement<HTMLElement>(".location-map-attribution");

let mapStatusText = "Online map off. Coordinates work offline.";
function setMapStatus(text: string): void {
  mapStatusText = text;
  mapOnlineStatus.textContent = lt(text);
}

function stopOnlineMap(reason = "Online map off. Coordinates work offline."): void {
  ++mapLoadEpoch;
  onlineMap?.remove();
  onlineMap = null;
  onlineGeneration = null;
  if (mapSessionId !== null)
    void request({ type: "map:close", sessionId: mapSessionId }, parseMapResponse);
  mapSessionId = null;
  mapLoad.disabled = false;
  mapLoad.textContent = message("loadOnlineMap");
  mapLoad.hidden = false;
  mapUnload.hidden = true;
  mapAttribution.textContent = lt(NO_TILES.attribution);
  setMapStatus(reason);
  ui.mapSurface.dataset.online = "off";
}

async function loadOnlineMap(userGesture = true): Promise<void> {
  if (mapLoad.disabled || onlineMap !== null || ui.form.hidden) return;
  const state = runtimeState;
  if (state === null) return;
  const epoch = ++mapLoadEpoch;
  const generation = state.generation;
  mapLoad.disabled = true;
  setMapStatus("Checking map consent and the applied route…");
  if (
    !(await ensureDirectIpConsent(state.appliedRoute === "proxy" ? "proxy" : "direct", userGesture))
  ) {
    if (epoch === mapLoadEpoch) {
      if (userGesture) rememberMapAutoload(false);
      stopOnlineMap("Public-IP permission was not granted. Coordinates still work offline.");
    }
    return;
  }
  if (epoch !== mapLoadEpoch || ui.form.hidden) return;
  const opened = await request({ type: "map:open", generation }, parseMapResponse);
  if (epoch !== mapLoadEpoch) {
    if (opened.ok && opened.value.ok && opened.value.sessionId !== undefined)
      void request({ type: "map:close", sessionId: opened.value.sessionId }, parseMapResponse);
    return;
  }
  if (!opened.ok || !opened.value.ok || opened.value.sessionId === undefined) {
    stopOnlineMap(
      opened.ok && !opened.value.ok
        ? opened.value.error
        : "Online map unavailable. Coordinates still work offline.",
    );
    return;
  }
  if (userGesture) rememberMapAutoload(true);
  mapSessionId = opened.value.sessionId;
  onlineGeneration = generation;
  setMapStatus("Loading OpenFreeMap through the applied route…");
  mapLoad.hidden = true;
  mapUnload.hidden = false;
  ui.mapSurface.dataset.online = "loading";
  try {
    onlineMap = createOnlineMap(
      ui.mapTiles,
      mapSessionId,
      mapViewport(),
      (fatal) =>
        queueMicrotask(() => {
          if (epoch !== mapLoadEpoch) return;
          if (fatal)
            stopOnlineMap(
              "Online map unavailable on this route or WebGL unavailable. Coordinates still work offline.",
            );
          else {
            ui.mapSurface.dataset.online = "partial";
            setMapStatus(
              "Some map data could not load. The displayed map may be incomplete; reload to try again.",
            );
            mapLoad.textContent = message("reloadOnlineMap");
            mapLoad.disabled = false;
            mapLoad.hidden = false;
          }
        }),
      () => {
        if (epoch !== mapLoadEpoch) return;
        ui.mapSurface.dataset.online = "ready";
        setMapStatus("Online map loaded. Panning and zooming send the viewed area to OpenFreeMap.");
      },
    );
    mapAttribution.replaceChildren();
    for (const [label, href] of [
      ["OpenFreeMap", "https://openfreemap.org/"],
      ["© OpenMapTiles", "https://openmaptiles.org/"],
      ["Data from OpenStreetMap", "https://www.openstreetmap.org/copyright"],
    ]) {
      const link = document.createElement("a");
      link.textContent = label ?? "";
      link.href = href ?? "";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      mapAttribution.append(link, " ");
    }
  } catch {
    stopOnlineMap("WebGL map unavailable. Coordinates still work offline.");
  }
}
mapLoad.addEventListener("click", () => {
  if (onlineMap !== null) {
    mapLoad.disabled = true;
    mapLoad.hidden = true;
    ui.mapSurface.dataset.online = "loading";
    setMapStatus("Reloading map data through the applied route…");
    try {
      onlineMap.reload();
    } catch {
      stopOnlineMap("WebGL map unavailable. Coordinates still work offline.");
    }
    return;
  }
  void loadOnlineMap();
});
mapUnload.addEventListener("click", () => {
  rememberMapAutoload(false);
  stopOnlineMap();
});
mapAutoload.addEventListener("change", () => {
  const enabled = mapAutoload.checked;
  rememberMapAutoload(enabled);
  if (enabled) void loadOnlineMap();
  else stopOnlineMap();
});

let capture: { element: HTMLElement; id: number } | null = null;
let wheelDelta = 0;
let lastWheelAt = 0;

function cancelMapInteraction(): void {
  map.cancel();
  const previous = capture;
  capture = null;
  if (previous?.element.hasPointerCapture(previous.id))
    previous.element.releasePointerCapture(previous.id);
  ui.mapSurface.classList.remove("is-grabbing");
  ui.mapMarker.classList.remove("is-dragging");
}

function editableLocation(): boolean {
  return ui.modeManual.checked && ui.geolocationPolicy.value === "manual";
}

function parseCoordinate(value: string, min: number, max: number): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < min || num > max) return null;
  return num;
}

function readForm(): ProfileFormValues {
  return {
    id: selectedId ?? undefined,
    name: ui.name.value,
    proxyType: ui.proxyType.value,
    proxyHost: ui.proxyHost.value,
    proxyPort: ui.proxyPort.value,
    proxyUsername: ui.proxyUsername.value,
    password: ui.password.value,
    removeCredentials: ui.removeCredentials.checked,
    proxyDns: ui.proxyDns.checked,
    bypassHosts: ui.bypass.value,
    identityMode: ui.modeManual.checked ? "manual" : "auto",
    geoIpPolicy: ui.geoIpPolicy.value,
    geolocationPolicy: ui.geolocationPolicy.value,
    timezonePolicy: ui.timezonePolicy.value,
    latitude: ui.latitude.value,
    longitude: ui.longitude.value,
    accuracy: ui.accuracy.value,
    timezone: ui.timezone.value,
    webrtcPolicy: ui.webrtc.value,
  };
}

function writeForm(values: ProfileFormValues): void {
  ui.name.value = values.name;
  ui.proxyType.value = values.proxyType;
  ui.proxyHost.value = values.proxyHost;
  ui.proxyPort.value = values.proxyPort;
  ui.proxyUsername.value = values.proxyUsername;
  ui.password.value = values.password;
  ui.removeCredentials.checked = values.removeCredentials;
  ui.proxyDns.checked = values.proxyDns;
  ui.bypass.value = values.bypassHosts;
  ui.modeAuto.checked = values.identityMode !== "manual";
  ui.modeManual.checked = values.identityMode === "manual";
  ui.geoIpPolicy.value = values.geoIpPolicy ?? "automatic";
  ui.geolocationPolicy.value = values.geolocationPolicy ?? "follow";
  ui.timezonePolicy.value = values.timezonePolicy ?? "follow";
  manualUserEdited = false;
  cancelMapInteraction();
  ui.latitude.value = values.latitude;
  ui.longitude.value = values.longitude;
  ui.accuracy.value = values.accuracy;
  ui.timezone.value = values.timezone;
  ui.webrtc.value = values.webrtcPolicy;
  updateVisibility();
}

let lastErrors: readonly string[] = [];
function showErrors(errors: readonly string[]): void {
  lastErrors = [...errors];
  if (errors.length === 0) {
    ui.errors.hidden = true;
    ui.errors.textContent = "";
    return;
  }
  ui.errors.hidden = false;
  ui.errors.textContent = errors.map(lt).join(" • ");
}

function selectedProfile(): IdentityProfile | null {
  return profiles.find((profile) => profile.id === selectedId) ?? null;
}

function syncMapSelection(recenter = false): void {
  map.editable = editableLocation();
  let point = null;
  if (editableLocation()) {
    const latitude = parseCoordinate(ui.latitude.value, -90, 90);
    const longitude = parseCoordinate(ui.longitude.value, -180, 180);
    if (latitude !== null && longitude !== null) point = { latitude, longitude };
  } else if (!ui.modeManual.checked || ui.geolocationPolicy.value === "follow") {
    const source =
      selectedId === activeProfileId ? runtimeState?.identity : selectedProfile()?.identity;
    if (source?.latitude !== undefined && source.longitude !== undefined)
      point = { latitude: source.latitude, longitude: source.longitude };
  }
  map.select(point, recenter);
}

function mapViewport(): MapViewport {
  map.resize(ui.mapSurface.clientWidth, ui.mapSurface.clientHeight);
  return map.viewport;
}

function renderLocationMap(): void {
  const viewport = mapViewport();
  const point = map.selection;
  if (editableLocation() && ui.timezonePolicy.value === "manual") {
    ui.identityWarning.textContent = lt(
      locationTimezoneWarning(Number(ui.longitude.value), ui.timezone.value, Date.now()) ??
        "Custom overrides are applied as entered; they may differ from the observed network location.",
    );
  }

  onlineMap?.update(viewport);
  ui.mapNotice.hidden = false;
  ui.mapNotice.textContent = formatMessage("mapCamera", {
    latitude: viewport.center.latitude.toFixed(3),
    longitude: viewport.center.longitude.toFixed(3),
    zoom: viewport.zoom,
  });
  ui.mapSurface.dataset.zoom = String(viewport.zoom);
  ui.mapSurface.dataset.center = `${viewport.center.latitude},${viewport.center.longitude}`;
  ui.mapSurface.style.backgroundPosition = `${-viewport.center.longitude * 2 ** viewport.zoom}px ${viewport.center.latitude * 2 ** viewport.zoom}px`;

  // Position marker and accuracy circle
  if (point === null) {
    ui.mapMarker.hidden = true;
    ui.mapAccuracy.hidden = true;
  } else {
    const markerPos = viewportPoint(viewport, point.latitude, point.longitude);
    ui.mapMarker.hidden = false;
    ui.mapMarker.style.left = `${markerPos.x}px`;
    ui.mapMarker.style.top = `${markerPos.y}px`;

    const radius = accuracyRadiusPixels(
      point.latitude,
      editableLocation() ? Number(ui.accuracy.value) : (resolvedSeed?.accuracy ?? 20000),
      viewport.zoom,
    );
    if (radius <= 0) {
      ui.mapAccuracy.hidden = true;
    } else {
      ui.mapAccuracy.hidden = false;
      const diameter = radius * 2;
      ui.mapAccuracy.style.width = `${diameter}px`;
      ui.mapAccuracy.style.height = `${diameter}px`;
      ui.mapAccuracy.style.left = `${markerPos.x}px`;
      ui.mapAccuracy.style.top = `${markerPos.y}px`;
      ui.mapAccuracy.style.marginLeft = `${-radius}px`;
      ui.mapAccuracy.style.marginTop = `${-radius}px`;
    }
  }

  ui.mapSurface.classList.toggle("is-grabbing", map.interaction?.kind === "pan");
}

function setManualPoint(latitude: number, longitude: number, edited: boolean): void {
  ui.latitude.value = String(Math.round(latitude * 1e6) / 1e6);
  ui.longitude.value = String(Math.round(longitude * 1e6) / 1e6);
  if (edited) manualUserEdited = true;
  syncMapSelection();
  renderLocationMap();
}

function updateVisibility(): void {
  draftCheck.refresh();
  const isManual = ui.modeManual.checked;
  const hasCredentials = selectedId !== null && credentialProfileIds.includes(selectedId);

  ui.policyFields.hidden = !isManual;
  ui.manualFields.hidden = !isManual;
  ui.latitude.disabled =
    ui.longitude.disabled =
    ui.accuracy.disabled =
      !isManual || ui.geolocationPolicy.value !== "manual";
  ui.timezone.disabled = !isManual || ui.timezonePolicy.value !== "manual";
  ui.proxyAddressFields.hidden = ui.proxyType.value === "direct";
  ui.identityWarning.hidden = !isManual;
  ui.identityWarning.textContent = lt(
    "Custom overrides are applied as entered. A manual location or timezone may disagree with the observed network location.",
  );
  ui.useGeoIpLocation.disabled =
    resolvedSeed?.latitude === undefined || resolvedSeed.longitude === undefined;
  ui.mapSurface.classList.toggle("is-preview", !editableLocation());
  cancelMapInteraction();
  syncMapSelection();
  renderLocationMap();
  ui.removeCredentialsRow.hidden = !hasCredentials;
  ui.proxyUsername.placeholder = hasCredentials ? message("savedAuthentication") : "";
  ui.password.placeholder = hasCredentials ? message("savedAuthentication") : "";

  renderHints();
  ui.proxyDns.disabled = !["socks4", "socks5"].includes(ui.proxyType.value);
}

function renderHints(): void {
  clear(ui.hints);
  for (const hint of proxyFieldHints(ui.proxyType.value)) {
    ui.hints.append(el("li", { text: lt(hint) }));
  }
  if (ui.modeManual.checked) {
    ui.hints.append(
      el("li", {
        text: message("manualAccuracyNotice"),
      }),
    );
  }
}

function renderProfileList(): void {
  clear(ui.list);
  const userProxies = profiles.filter((p) => p.id !== BUILTIN_DIRECT_PROFILE_ID);
  ui.listEmpty.hidden = userProxies.length > 0;

  for (const profile of profiles) {
    const isDirect = profile.id === BUILTIN_DIRECT_PROFILE_ID;
    const badges: Node[] = [];
    if (profile.id === activeProfileId) {
      badges.push(el("span", { className: "badge", text: message("activeBadge") }));
    }
    if (credentialProfileIds.includes(profile.id)) {
      badges.push(el("span", { className: "badge", text: message("sessionCredentialsBadge") }));
    }
    if (isDirect) {
      badges.push(
        el("span", {
          className: "badge",
          attrs: { "data-tone": "ok" },
          text: message("builtInBadge"),
        }),
      );
    }

    const subtitle = isDirect
      ? "Browser / system routing · Automatic identity"
      : `${describeProxy(profile.proxy)} · ${profile.identity.mode === "auto" ? message("automaticLabel") : message("manualLabel")} · WebRTC ${profile.webrtcPolicy}`;

    const item = el("li", {
      attrs: {
        "data-profile-id": profile.id,
        "aria-selected": String(profile.id === selectedId),
        tabindex: "0",
      },
      onClick: () => {
        selectProfile(profile.id);
      },
      children: [
        el("div", {
          className: "name",
          children: [
            el("span", { text: isDirect ? message("browserRouting") : profile.name }),
            ...badges,
          ],
        }),
        el("div", {
          className: "meta",
          text: lt(subtitle),
        }),
      ],
    });
    item.setAttribute("role", "option");
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectProfile(profile.id);
      }
    });
    ui.list.append(item);
  }
}

function selectProfile(profileId: string | null): void {
  editorRevision++;
  selectionRevision++;
  credentialEndpoint = null;
  draftCheck.cancel();
  requireElement<HTMLDetailsElement>("#section-auth").open = false;
  requireElement<HTMLDetailsElement>("#section-identity").open = false;
  stopOnlineMap();
  cancelMapInteraction();
  wheelDelta = 0;
  selectedId = profileId;
  const isDirect = profileId === BUILTIN_DIRECT_PROFILE_ID;

  if (isDirect) {
    ui.directView.hidden = false;
    ui.form.hidden = true;
    ui.directActiveBadge.hidden = activeProfileId !== BUILTIN_DIRECT_PROFILE_ID;
    ui.directActivate.disabled = activeProfileId === BUILTIN_DIRECT_PROFILE_ID;
    ui.directDeactivate.disabled = activeProfileId === null;
  } else {
    ui.directView.hidden = true;
    ui.form.hidden = false;
    const profile = selectedProfile();
    writeForm(toFormValues(profile));
    requireElement<HTMLDetailsElement>("#section-auth").open =
      profileId !== null && credentialProfileIds.includes(profileId);

    ui.formTitle.textContent = profile === null ? message("newProfile") : profile.name;
    ui.formBadge.hidden = profile === null || profile.id !== activeProfileId;

    const hasSelection = profile !== null;
    ui.delete.disabled = !hasSelection;
    ui.duplicate.disabled = !hasSelection;
    ui.saveActivate.disabled = false;
    ui.deactivate.disabled = activeProfileId === null;

    syncMapSelection();
    map.reset(
      map.selection,
      map.selection === null
        ? 2
        : zoomToFitAccuracy(map.selection.latitude, Number(ui.accuracy.value) || 20000, 280),
      editableLocation(),
    );
    updateVisibility();
  }

  renderProfileList();
  renderSaveStatus();
}

function renderSaveStatus(): void {
  const profile = selectedProfile();
  ui.delete.disabled = profile === null;
  ui.duplicate.disabled = profile === null;
  ui.formBadge.hidden = profile === null || profile.id !== activeProfileId;
  const pending =
    profile !== null &&
    profile.id === runtimeState?.activeProfileId &&
    (profile.revision ?? 1) !== runtimeState.appliedRevision;
  ui.saveStatus.textContent = `${pending ? message("pendingDraftChanges") + " · " : ""}${message("enableDraftHint")}`;
  ui.saveActivate.textContent = message("enableDraft");
}

function renderStatus(state: RuntimeState): void {
  if (onlineGeneration !== null && onlineGeneration !== state.generation)
    stopOnlineMap("Route changed. Load the online map again for this route.");
  runtimeState = state;
  activeProfileId = state.activeProfileId;
  renderSaveStatus();
  resolvedSeed =
    draftSeed ??
    (state.activeProfileId === selectedId ? (state.identity.geoIpLocation ?? null) : null);
  ui.useGeoIpLocation.disabled =
    resolvedSeed?.latitude === undefined || resolvedSeed.longitude === undefined;
  renderRuntimeRows(state);
  syncMapSelection();
  renderLocationMap();
}

function renderRuntimeRows(state: RuntimeState): void {
  clear(ui.status);

  const addRow = (label: string, value: string, status: string): void => {
    ui.status.append(
      el("div", {
        className: "row",
        attrs: { "data-status": status },
        children: [
          el("span", { className: "label", text: lt(label) }),
          el("span", { className: "value", text: value }),
        ],
      }),
    );
  };

  addRow(
    "Profile",
    state.activeProfileName ?? "none",
    state.activeProfileId === null ? "not_configured" : "ok",
  );
  addRow(
    "Routing",
    `${state.desiredRoute} / ${state.appliedRoute}`,
    state.appliedRoute === "blocked" ? "error" : "ok",
  );
  addRow("Network health", state.runtimeHealth, state.runtimeHealth === "healthy" ? "ok" : "error");
  addRow(
    "Public IP",
    state.identity.publicIp === undefined
      ? "unknown"
      : `${state.identity.publicIp}${state.identity.publicIpVerified ? "" : " (unverified)"}`,
    state.identity.publicIp === undefined
      ? "unavailable"
      : state.identity.publicIpVerified
        ? "ok"
        : "pending",
  );
  addRow(
    "Coordinates",
    state.identity.latitude === undefined || state.identity.longitude === undefined
      ? "not applied"
      : `${formatCoordinates(state.identity.latitude, state.identity.longitude)} ${formatAccuracy(state.identity.accuracy)}`,
    state.identity.latitude === undefined ? "unavailable" : "ok",
  );
  addRow(
    "Timezone",
    state.identity.timezone ?? "not applied",
    state.identity.timezone === undefined ? "unavailable" : "ok",
  );
  addRow(
    "WebRTC policy",
    state.webrtc.status === "applied" || state.webrtc.status === "already"
      ? state.webrtc.desired
      : `${state.webrtc.desired} (${state.webrtc.status})`,
    state.webrtc.status === "applied" || state.webrtc.status === "already" ? "ok" : "unavailable",
  );
  addRow(
    "Firefox proxy settings",
    `proxyType=${state.firefoxProxy.proxyType} (${state.firefoxProxy.levelOfControl})`,
    state.firefoxProxy.proxyType === "none" ? "ok" : "not_configured",
  );
  addRow(
    "Consistency",
    state.audit.verdict,
    state.audit.verdict === "consistent"
      ? "ok"
      : state.audit.verdict === "error"
        ? "error"
        : "pending",
  );

  for (const check of state.audit.checks) {
    addRow(check.label, lt(check.detail ?? ""), check.status);
  }

  if (state.lastError !== undefined) {
    addRow("Last error", state.lastError.message, "error");
  }
}

async function reload(
  selectAfter: string | null = null,
  initialEditorRevision: number = editorRevision,
  preserveEditor = false,
): Promise<ProfilesResponse | null> {
  const [profilesResponse, stateResponse] = await Promise.all([
    request({ type: "profiles:list" }, parseProfilesResponse),
    request({ type: "state:get" }, parseStateResponse),
  ]);

  if (!profilesResponse.ok) {
    showErrors(profilesResponse.errors);
    return null;
  }
  const snapshot = profilesResponse.value;
  profiles = snapshot.profiles;
  activeProfileId = snapshot.activeProfileId;
  credentialProfileIds = snapshot.credentialProfileIds;

  if (stateResponse.ok) renderStatus(stateResponse.value.state);

  const desiredSelection =
    selectAfter ??
    (selectedId !== null && profiles.some((profile) => profile.id === selectedId)
      ? selectedId
      : BUILTIN_DIRECT_PROFILE_ID);
  if (initialEditorRevision === editorRevision && !preserveEditor) selectProfile(desiredSelection);
  else {
    renderProfileList();
    updateVisibility();
    renderSaveStatus();
    if (selectedProfile() !== null) ui.formTitle.textContent = ui.name.value;
  }
  return snapshot;
}

let savePending = false;
async function saveProfile(): Promise<IdentityProfile | null> {
  if (savePending) return null;
  savePending = true;
  ui.save.disabled = true;
  try {
    return await persistProfile();
  } finally {
    savePending = false;
    ui.save.disabled = false;
  }
}

async function persistProfile(): Promise<IdentityProfile | null> {
  const saveRevision = editorRevision;
  const saveSelection = selectionRevision;
  const values = readForm();
  if (values.name.trim() === "")
    values.name = `${values.proxyType.toUpperCase()} ${values.proxyHost}:${values.proxyPort}`;
  const id = values.id ?? createProfileId();
  const parsed = parseProfile(toProfileInput({ ...values, id }, id));

  if (!parsed.ok) {
    showErrors(parsed.errors);
    return null;
  }

  const profile = parsed.value;
  const intent = credentialsIntentFrom(values);

  const response = await request(
    {
      type: "profiles:save",
      profile,
      ...(intent.action === "clear"
        ? { credentials: null }
        : intent.action === "set"
          ? { credentials: { username: intent.username, password: intent.password } }
          : {}),
    },
    parseMutationResponse,
  );

  if (!response.ok) {
    showErrors(response.errors);
    return null;
  }
  if (!response.value.ok) {
    showErrors(response.value.errors);
    return null;
  }

  showErrors([]);
  // Saving must not reset an editor that the user is still filling in.
  // Bind a newly saved draft to its id only if the same editor is still open.
  if (selectionRevision === saveSelection) {
    selectedId = profile.id;
    if (editorRevision === saveRevision) {
      credentialEndpoint = credentialEndpointKey();
      ui.name.value = profile.name;
    }
    if (intent.action === "clear" && editorRevision === saveRevision) {
      ui.proxyUsername.value = "";
      ui.password.value = "";
      ui.removeCredentials.checked = false;
    }
  }
  renderStatus(response.value.state);
  await reload(profile.id, saveRevision, true);
  return profile;
}

async function activateProfileById(profileId: string, preserveEditor = false): Promise<void> {
  const activationRevision = editorRevision;
  const response = await request({ type: "profiles:activate", profileId }, parseMutationResponse);
  if (!response.ok) {
    showErrors(response.errors);
    return;
  }
  if (!response.value.ok) {
    showErrors(response.value.errors);
  }
  renderStatus(response.value.state);
  if (preserveEditor) renderProfileList();
  else await reload(profileId, activationRevision, selectedId === profileId);
}

async function duplicateSelected(): Promise<void> {
  if (selectedId === null || selectedId === BUILTIN_DIRECT_PROFILE_ID) return;
  const response = await request(
    { type: "profiles:duplicate", profileId: selectedId },
    parseMutationResponse,
  );
  if (!response.ok) {
    showErrors(response.errors);
    return;
  }
  if (!response.value.ok) {
    showErrors(response.value.errors);
    return;
  }
  const snapshot = await reload();
  const newest = snapshot?.profiles.at(-1);
  if (newest !== undefined) selectProfile(newest.id);
}

async function deleteSelected(): Promise<void> {
  const profile = selectedProfile();
  if (profile === null || profile.id === BUILTIN_DIRECT_PROFILE_ID) return;
  if (
    !window.confirm(
      formatMessage(profile.id === activeProfileId ? "deleteActiveProfile" : "deleteProfile", {
        name: profile.name,
      }),
    )
  )
    return;

  const response = await request(
    { type: "profiles:delete", profileId: profile.id },
    parseMutationResponse,
  );
  if (!response.ok) {
    showErrors(response.errors);
    return;
  }
  if (!response.value.ok) {
    showErrors(response.value.errors);
    return;
  }
  selectedId = BUILTIN_DIRECT_PROFILE_ID;
  renderStatus(response.value.state);
  await reload(BUILTIN_DIRECT_PROFILE_ID);
}

async function deactivate(): Promise<void> {
  const response = await request({ type: "profiles:deactivate" }, parseMutationResponse);
  if (!response.ok) {
    showErrors(response.errors);
    return;
  }
  renderStatus(response.value.state);
  await reload();
}

async function refreshIdentity(): Promise<void> {
  const refreshRevision = editorRevision;
  ui.refreshIdentity.disabled = true;
  const response = await request({ type: "identity:refresh" }, parseMutationResponse);
  ui.refreshIdentity.disabled = false;
  if (!response.ok) {
    showErrors(response.errors);
    return;
  }
  renderStatus(response.value.state);
  await reload(selectedId, refreshRevision, true);
}

for (const field of [ui.geoIpPolicy, ui.geolocationPolicy, ui.timezonePolicy])
  field.addEventListener("change", updateVisibility);

// Event Listeners
ui.form.addEventListener("input", () => {
  editorRevision++;
});
ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveProfile();
});

ui.newProfile.addEventListener("click", () => {
  showErrors([]);
  selectProfile(null);
});

async function applySelected(): Promise<void> {
  if (ui.form.inert) return;
  draftCheck.cancel(true);
  ui.form.inert = true;
  ui.list.inert = true;
  ui.newProfile.disabled = true;
  try {
    const profile = await saveProfile();
    if (profile !== null) await activateProfileById(profile.id);
  } finally {
    ui.form.inert = false;
    ui.list.inert = false;
    ui.newProfile.disabled = false;
  }
}

ui.saveActivate.addEventListener("click", () => {
  void applySelected();
});

ui.duplicate.addEventListener("click", () => {
  void duplicateSelected();
});

ui.delete.addEventListener("click", () => {
  void deleteSelected();
});

ui.deactivate.addEventListener("click", () => {
  void deactivate();
});

ui.directActivate.addEventListener("click", () => {
  void activateProfileById(BUILTIN_DIRECT_PROFILE_ID);
});

requireElement<HTMLButtonElement>("#direct-resolve").addEventListener("click", () => {
  void (async () => {
    if (await ensureDirectIpConsent("direct")) await activateProfileById(BUILTIN_DIRECT_PROFILE_ID);
  })();
});

ui.directDeactivate.addEventListener("click", () => {
  void deactivate();
});

ui.refreshIdentity.addEventListener("click", () => {
  void refreshIdentity();
});

requireElement<HTMLDetailsElement>("#section-identity").addEventListener("toggle", (event) => {
  if (!(event.currentTarget as HTMLDetailsElement).open) {
    stopOnlineMap();
    cancelMapInteraction();
  } else if (mapAutoload.checked) {
    void loadOnlineMap(false);
  }
});

ui.proxyType.addEventListener("change", () => {
  updateVisibility();
});

ui.modeAuto.addEventListener("change", () => {
  updateVisibility();
});

ui.modeManual.addEventListener("change", () => {
  if (ui.modeManual.checked && !manualUserEdited) {
    ui.geolocationPolicy.value = "manual";
    ui.timezonePolicy.value = "manual";
    const seeded = seedBlankManualFields(
      {
        latitude: ui.latitude.value,
        longitude: ui.longitude.value,
        accuracy: ui.accuracy.value,
        timezone: ui.timezone.value,
      },
      resolvedSeed,
      false,
    );
    ui.latitude.value = seeded.latitude;
    ui.longitude.value = seeded.longitude;
    ui.accuracy.value = seeded.accuracy;
    ui.timezone.value = seeded.timezone;
  }
  updateVisibility();
});

for (const field of [ui.latitude, ui.longitude])
  field.addEventListener("input", () => {
    manualUserEdited = true;
    syncMapSelection(true);
    renderLocationMap();
  });

ui.timezone.addEventListener("input", () => renderLocationMap());

ui.accuracy.addEventListener("input", () => {
  renderLocationMap();
});

ui.useGeoIpLocation.addEventListener("click", () => {
  if (
    resolvedSeed === null ||
    resolvedSeed.latitude === undefined ||
    resolvedSeed.longitude === undefined
  ) {
    return;
  }
  const next = applyResolvedLocation(
    {
      latitude: ui.latitude.value,
      longitude: ui.longitude.value,
      accuracy: ui.accuracy.value,
      timezone: ui.timezone.value,
    },
    resolvedSeed,
  );
  ui.modeManual.checked = true;
  ui.geolocationPolicy.value = "manual";
  ui.modeAuto.checked = false;
  ui.latitude.value = next.latitude;
  ui.longitude.value = next.longitude;
  ui.accuracy.value = next.accuracy;
  ui.timezone.value = next.timezone;
  manualUserEdited = false;
  syncMapSelection(true);
  cancelMapInteraction();
  updateVisibility();
});

function adjustZoom(delta: number): void {
  map.zoom(delta);
  renderLocationMap();
}
ui.mapZoomIn.addEventListener("click", () => adjustZoom(1));
ui.mapZoomOut.addEventListener("click", () => adjustZoom(-1));

function pointerPoint(event: MouseEvent): { x: number; y: number } {
  const bounds = ui.mapSurface.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}
function writeMapSelection(): void {
  if (map.selection !== null) setManualPoint(map.selection.latitude, map.selection.longitude, true);
}
ui.mapSurface.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  if (event.target instanceof Element && event.target.closest("button, a")) return;
  const marker = event.target === ui.mapMarker;
  if (!map.begin(event.pointerId, marker ? "marker" : "pan", pointerPoint(event))) return;
  event.preventDefault();
  const element = marker ? ui.mapMarker : ui.mapSurface;
  element.setPointerCapture(event.pointerId);
  capture = { element, id: event.pointerId };
  renderLocationMap();
});
window.addEventListener("pointermove", (event) => {
  if (map.move(event.pointerId, pointerPoint(event))) writeMapSelection();
  if (map.interaction !== null) renderLocationMap();
});
window.addEventListener("pointerup", (event) => {
  if (map.interaction?.id !== event.pointerId) return;
  if (map.end(event.pointerId, pointerPoint(event))) writeMapSelection();
  cancelMapInteraction();
  renderLocationMap();
});
for (const name of ["pointercancel", "lostpointercapture"] as const)
  ui.mapSurface.addEventListener(name, (event) => {
    if (map.interaction?.id === event.pointerId) cancelMapInteraction();
  });
window.addEventListener("blur", cancelMapInteraction);
window.addEventListener("pagehide", () => {
  cancelMapInteraction();
  stopOnlineMap();
});
ui.mapSurface.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    if (Date.now() - lastWheelAt > 180) wheelDelta = 0;
    lastWheelAt = Date.now();
    wheelDelta +=
      event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? map.viewport.height : 1);
    if (Math.abs(wheelDelta) < 40) return;
    map.zoom(-Math.sign(wheelDelta), pointerPoint(event));
    wheelDelta = 0;
    renderLocationMap();
  },
  { passive: false },
);
ui.mapSurface.addEventListener("keydown", (event) => {
  const deltas: Record<string, [number, number]> = {
    ArrowLeft: [32, 0],
    ArrowRight: [-32, 0],
    ArrowUp: [0, 32],
    ArrowDown: [0, -32],
  };
  const delta = deltas[event.key];
  if (delta === undefined) return;
  event.preventDefault();
  const marker = event.target === ui.mapMarker;
  map.nudge(delta[0], delta[1], marker);
  if (marker) writeMapSelection();
  renderLocationMap();
});

// Robust Map Sizing with ResizeObserver
const mapResizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
      renderLocationMap();
    }
  }
});
mapResizeObserver.observe(ui.mapSurface);

onRuntimeMessage((message) => {
  const parsed = parseOutboundMessage(message);
  if (!parsed.ok) return undefined;
  if (parsed.value.type === "state:changed") {
    renderStatus(parsed.value.state);
    return undefined;
  }
  return undefined;
});

void (async () => {
  const initialEditorRevision = editorRevision;
  const initialVersion = mapPreferenceVersion;
  try {
    const enabled = await readMapAutoload();
    if (initialVersion === mapPreferenceVersion) mapAutoload.checked = enabled;
  } catch {
    /* Missing preference must never initiate a map request. */
  }
  await bindLanguageControl(() => {
    renderGuide();
    renderHints();
    showErrors(lastErrors);
    renderProfileList();
    setMapStatus(mapStatusText);
    mapLoad.textContent = message(onlineMap ? "reloadOnlineMap" : "loadOnlineMap");
    if (!onlineMap) mapAttribution.textContent = message("localGrid");
    renderSaveStatus();
    if (runtimeState) renderRuntimeRows(runtimeState);
    if (selectedProfile() === null) ui.formTitle.textContent = message("newProfile");
  });
  if (!(await bindVaultControls())) return;
  await reload(null, initialEditorRevision);
  renderProfileList();
})();
