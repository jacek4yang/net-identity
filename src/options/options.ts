/**
 * Options page: profile CRUD and management.
 *
 * The DOM layer stays thin: field values are turned into a candidate profile by
 * `form.ts` (pure, unit tested) and validated by the same `parseProfile` used by
 * the background script, so the UI cannot save something the background would
 * reject.
 *
 * Credentials: the password travels from this page to the background script over
 * `runtime.sendMessage` only, is never written to local storage, and is cleared
 * from the field after a successful save.
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
import { ensureDirectIpConsent, onRuntimeMessage, request } from "../shared/runtime";
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
for (const section of GUIDE) {
  guideBody.append(
    el("h3", { text: section.title }),
    el("p", { className: "hint", text: section.body }),
  );
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
let manualUserEdited = false;
let resolvedSeed: LocationSeed | null = null;

const map = new LocationMapModel();
let onlineMap: OnlineMap | null = null;
let mapSessionId: string | null = null;
let onlineGeneration: number | null = null;
let mapLoadEpoch = 0;
const mapLoad = requireElement<HTMLButtonElement>("#load-online-map");
const mapUnload = requireElement<HTMLButtonElement>("#unload-online-map");
const mapOnlineStatus = requireElement<HTMLElement>("#map-online-status");
const mapAttribution = requireElement<HTMLElement>(".location-map-attribution");

function stopOnlineMap(message = "Online map off. Coordinates work offline."): void {
  ++mapLoadEpoch;
  onlineMap?.remove();
  onlineMap = null;
  onlineGeneration = null;
  if (mapSessionId !== null)
    void request({ type: "map:close", sessionId: mapSessionId }, parseMapResponse);
  mapSessionId = null;
  mapLoad.disabled = false;
  mapLoad.textContent = "Load online map";
  mapLoad.hidden = false;
  mapUnload.hidden = true;
  mapAttribution.textContent = NO_TILES.attribution;
  mapOnlineStatus.textContent = message;
  ui.mapSurface.dataset.online = "off";
}

async function loadOnlineMap(): Promise<void> {
  if (mapLoad.disabled || onlineMap !== null || ui.form.hidden) return;
  const state = runtimeState;
  if (state === null) return;
  const epoch = ++mapLoadEpoch;
  const generation = state.generation;
  mapLoad.disabled = true;
  mapOnlineStatus.textContent = "Checking map consent and the applied route…";
  if (!(await ensureDirectIpConsent(state.appliedRoute === "proxy" ? "proxy" : "direct"))) {
    if (epoch === mapLoadEpoch)
      stopOnlineMap("Public-IP permission was not granted. Coordinates still work offline.");
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
  mapSessionId = opened.value.sessionId;
  onlineGeneration = generation;
  mapOnlineStatus.textContent = "Loading OpenFreeMap through the applied route…";
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
            mapOnlineStatus.textContent =
              "Some map data could not load. The displayed map may be incomplete; reload to try again.";
            mapLoad.textContent = "Reload online map";
            mapLoad.disabled = false;
            mapLoad.hidden = false;
          }
        }),
      () => {
        if (epoch !== mapLoadEpoch) return;
        ui.mapSurface.dataset.online = "ready";
        mapOnlineStatus.textContent =
          "Online map loaded. Panning and zooming send the viewed area to OpenFreeMap.";
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
  if (onlineMap !== null) stopOnlineMap();
  void loadOnlineMap();
});
mapUnload.addEventListener("click", () => stopOnlineMap());
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

function showErrors(errors: readonly string[]): void {
  if (errors.length === 0) {
    ui.errors.hidden = true;
    ui.errors.textContent = "";
    return;
  }
  ui.errors.hidden = false;
  ui.errors.textContent = errors.join(" • ");
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
    ui.identityWarning.textContent =
      locationTimezoneWarning(Number(ui.longitude.value), ui.timezone.value, Date.now()) ??
      "Custom overrides are applied as entered; they may differ from the observed network location.";
  }

  onlineMap?.update(viewport);
  ui.mapNotice.hidden = false;
  ui.mapNotice.textContent = `Center ${viewport.center.latitude.toFixed(3)}, ${viewport.center.longitude.toFixed(3)} · Zoom ${viewport.zoom}`;
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
  ui.identityWarning.textContent =
    "Custom overrides are applied as entered. A manual location or timezone may disagree with the observed network location.";
  ui.useGeoIpLocation.disabled =
    resolvedSeed?.latitude === undefined || resolvedSeed.longitude === undefined;
  ui.mapSurface.classList.toggle("is-preview", !editableLocation());
  cancelMapInteraction();
  syncMapSelection();
  renderLocationMap();
  ui.removeCredentialsRow.hidden = !hasCredentials;

  clear(ui.hints);
  for (const hint of proxyFieldHints(ui.proxyType.value)) {
    ui.hints.append(el("li", { text: hint }));
  }
  if (isManual) {
    ui.hints.append(
      el("li", {
        text: "Manual coordinates are applied to pages as-is, with the accuracy you provide.",
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
      badges.push(el("span", { className: "badge", text: "active" }));
    }
    if (credentialProfileIds.includes(profile.id)) {
      badges.push(el("span", { className: "badge", text: "session credentials" }));
    }
    if (isDirect) {
      badges.push(
        el("span", { className: "badge", attrs: { "data-tone": "ok" }, text: "built-in" }),
      );
    }

    const subtitle = isDirect
      ? "Browser / system routing · Automatic identity"
      : `${describeProxy(profile.proxy)} · ${profile.identity.mode} identity · WebRTC ${profile.webrtcPolicy}`;

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
          children: [el("span", { text: profile.name }), ...badges],
        }),
        el("div", {
          className: "meta",
          text: subtitle,
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

    ui.formTitle.textContent = profile === null ? "New profile" : profile.name;
    ui.formBadge.hidden = profile === null || profile.id !== activeProfileId;

    const hasSelection = profile !== null;
    ui.delete.disabled = !hasSelection;
    ui.duplicate.disabled = !hasSelection;
    ui.saveActivate.disabled = !hasSelection;
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
  const pending =
    profile !== null &&
    profile.id === runtimeState?.activeProfileId &&
    (profile.revision ?? 1) !== runtimeState.appliedRevision;
  ui.saveStatus.textContent = pending
    ? "Saved changes are pending. Apply to update the active route."
    : "Save stores edits. Apply activates the saved configuration; unsaved edits stay in the form.";
  ui.saveActivate.textContent = "Apply";
}

function renderStatus(state: RuntimeState): void {
  if (onlineGeneration !== null && onlineGeneration !== state.generation)
    stopOnlineMap("Route changed. Load the online map again for this route.");
  runtimeState = state;
  activeProfileId = state.activeProfileId;
  renderSaveStatus();
  resolvedSeed = state.identity.geoIpLocation ?? null;
  ui.useGeoIpLocation.disabled =
    resolvedSeed?.latitude === undefined || resolvedSeed.longitude === undefined;
  clear(ui.status);

  const addRow = (label: string, value: string, status: string): void => {
    ui.status.append(
      el("div", {
        className: "row",
        attrs: { "data-status": status },
        children: [
          el("span", { className: "label", text: label }),
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
    addRow(check.label, check.detail ?? "", check.status);
  }

  if (state.lastError !== undefined) {
    addRow("Last error", state.lastError.message, "error");
  }
  syncMapSelection();
  renderLocationMap();
}

async function reload(selectAfter: string | null = null): Promise<ProfilesResponse | null> {
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
  selectProfile(desiredSelection);
  return snapshot;
}

async function saveProfile(): Promise<IdentityProfile | null> {
  const values = readForm();
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
  ui.password.value = "";
  renderStatus(response.value.state);
  await reload(profile.id);
  return profile;
}

async function activateProfileById(profileId: string, preserveEditor = false): Promise<void> {
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
  else await reload(profileId);
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
      `Delete${profile.id === activeProfileId ? " and deactivate" : ""} the profile “${profile.name}”?`,
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
  ui.refreshIdentity.disabled = true;
  const response = await request({ type: "identity:refresh" }, parseMutationResponse);
  ui.refreshIdentity.disabled = false;
  if (!response.ok) {
    showErrors(response.errors);
    return;
  }
  renderStatus(response.value.state);
  await reload(selectedId);
}

for (const field of [ui.geoIpPolicy, ui.geolocationPolicy, ui.timezonePolicy])
  field.addEventListener("change", updateVisibility);

// Event Listeners
ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveProfile();
});

ui.newProfile.addEventListener("click", () => {
  showErrors([]);
  selectProfile(null);
});

async function applySelected(): Promise<void> {
  const profile = selectedProfile();
  if (profile === null) return;
  await activateProfileById(profile.id, true);
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
  await reload();
  renderProfileList();
})();
