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
  latLngFromViewport,
  panViewport,
  seedBlankManualFields,
  viewportPoint,
  visibleTiles,
  zoomToFitAccuracy,
  MAP_MAX_LATITUDE,
  type LocationSeed,
  type MapLatLng,
  type MapViewport,
} from "./location-map";
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
let activeProfileId: string | null = null;
let credentialProfileIds: string[] = [];
let selectedId: string | null = null;
let manualUserEdited = false;
let resolvedSeed: LocationSeed | null = null;

/** Map viewport center is decoupled from the selected location. */
let viewportCenter: MapLatLng = { latitude: 20, longitude: 0 };
/** Null means the zoom follows the accuracy circle. A zoom button pins an explicit level. */
let mapZoom: number | null = null;
let activeDrag: {
  type: "pan" | "marker";
  originX: number;
  originY: number;
  lastX: number;
  lastY: number;
} | null = null;

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
    latitude: ui.latitude.value,
    longitude: ui.longitude.value,
    accuracy: ui.accuracy.value,
    timezone: ui.timezone.value,
    webrtcPolicy: ui.webrtc.value,
  };
}

function writeForm(values: ProfileFormValues): void {
  ui.name.value = values.name;
  ui.proxyType.value = values.proxyType === "direct" ? "http" : values.proxyType;
  ui.proxyHost.value = values.proxyHost;
  ui.proxyPort.value = values.proxyPort;
  ui.proxyUsername.value = values.proxyUsername;
  ui.password.value = values.password;
  ui.removeCredentials.checked = values.removeCredentials;
  ui.proxyDns.checked = values.proxyDns;
  ui.bypass.value = values.bypassHosts;
  ui.modeAuto.checked = values.identityMode !== "manual";
  ui.modeManual.checked = values.identityMode === "manual";
  manualUserEdited = false;
  mapZoom = null;
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

function displayedPoint(): {
  latitude: number;
  longitude: number;
  accuracy: number;
  hasPoint: boolean;
} {
  if (
    !ui.modeManual.checked &&
    resolvedSeed !== null &&
    resolvedSeed.latitude !== undefined &&
    resolvedSeed.longitude !== undefined
  ) {
    return {
      latitude: resolvedSeed.latitude,
      longitude: resolvedSeed.longitude,
      accuracy: resolvedSeed.accuracy ?? 20000,
      hasPoint: true,
    };
  }

  const lat = parseCoordinate(ui.latitude.value, -MAP_MAX_LATITUDE, MAP_MAX_LATITUDE);
  const lng = parseCoordinate(ui.longitude.value, -180, 180);
  const acc = Number(ui.accuracy.value);

  if (lat !== null && lng !== null) {
    return {
      latitude: lat,
      longitude: lng,
      accuracy: Number.isFinite(acc) && acc > 0 ? acc : 1000,
      hasPoint: true,
    };
  }

  return {
    latitude: viewportCenter.latitude,
    longitude: viewportCenter.longitude,
    accuracy: 1000,
    hasPoint: false,
  };
}

function mapViewport(): MapViewport {
  const height = ui.mapSurface.clientHeight || 280;
  const width = ui.mapSurface.clientWidth || 640;
  const point = displayedPoint();
  return {
    width,
    height,
    zoom:
      mapZoom ?? (point.hasPoint ? zoomToFitAccuracy(point.latitude, point.accuracy, height) : 2),
    center: viewportCenter,
  };
}

function renderLocationMap(): void {
  const viewport = mapViewport();
  const point = displayedPoint();

  // Render tiles
  const tiles = visibleTiles(viewport);
  const existing = new Map<string, HTMLImageElement>();
  for (const node of ui.mapTiles.querySelectorAll("img")) {
    if (!(node instanceof HTMLImageElement)) continue;
    const url = node.dataset["url"];
    if (url === undefined) {
      node.remove();
      continue;
    }
    existing.set(url, node);
  }
  const next = new Set(tiles.map((tile) => tile.url));
  for (const [url, image] of existing) {
    if (!next.has(url)) image.remove();
  }
  for (const tile of tiles) {
    let image = existing.get(tile.url);
    if (image === undefined) {
      const created = document.createElement("img");
      created.alt = "";
      // NOTE: OpenStreetMap Tile Usage Policy requires standard referrer.
      // Do not strip Referer via no-referrer.
      created.dataset["url"] = tile.url;
      created.src = tile.url;
      created.addEventListener("error", () => {
        ui.mapNotice.hidden = false;
        created.remove();
      });
      ui.mapTiles.append(created);
      image = created;
    }
    image.style.left = `${tile.left}px`;
    image.style.top = `${tile.top}px`;
  }

  // Position marker and accuracy circle
  if (!point.hasPoint) {
    ui.mapMarker.hidden = true;
    ui.mapAccuracy.hidden = true;
  } else {
    const markerPos = viewportPoint(viewport, point.latitude, point.longitude);
    ui.mapMarker.hidden = false;
    ui.mapMarker.style.left = `${markerPos.x}px`;
    ui.mapMarker.style.top = `${markerPos.y}px`;

    const radius = accuracyRadiusPixels(point.latitude, point.accuracy, viewport.zoom);
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

  ui.mapSurface.classList.toggle("is-grabbing", activeDrag?.type === "pan");
}

function setManualPoint(latitude: number, longitude: number, edited: boolean): void {
  ui.latitude.value = String(Math.round(latitude * 1e6) / 1e6);
  ui.longitude.value = String(Math.round(longitude * 1e6) / 1e6);
  if (edited) manualUserEdited = true;
  renderLocationMap();
}

function updateVisibility(): void {
  const isManual = ui.modeManual.checked;
  const hasCredentials = selectedId !== null && credentialProfileIds.includes(selectedId);

  ui.manualFields.hidden = !isManual;
  ui.mapSurface.classList.toggle("is-preview", !isManual);
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
    ui.list.append(item);
  }
}

function selectProfile(profileId: string | null): void {
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
    ui.saveActivate.disabled = false;
    ui.deactivate.disabled = activeProfileId === null;

    // Recenter map on profile coordinates
    if (
      profile?.identity.mode === "manual" &&
      profile.identity.latitude !== undefined &&
      profile.identity.longitude !== undefined
    ) {
      viewportCenter = {
        latitude: profile.identity.latitude,
        longitude: profile.identity.longitude,
      };
      mapZoom = zoomToFitAccuracy(
        profile.identity.latitude,
        profile.identity.accuracy ?? 1000,
        280,
      );
    } else if (resolvedSeed?.latitude !== undefined && resolvedSeed?.longitude !== undefined) {
      viewportCenter = { latitude: resolvedSeed.latitude, longitude: resolvedSeed.longitude };
      mapZoom = zoomToFitAccuracy(resolvedSeed.latitude, resolvedSeed.accuracy ?? 20000, 280);
    } else {
      viewportCenter = { latitude: 20, longitude: 0 };
      mapZoom = 2;
    }
    updateVisibility();
  }

  renderProfileList();
}

function renderStatus(state: RuntimeState): void {
  resolvedSeed = {
    latitude: state.identity.latitude,
    longitude: state.identity.longitude,
    accuracy: state.identity.accuracy,
    timezone: state.identity.timezone,
  };
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

async function activateProfileById(profileId: string, proxyType: string): Promise<void> {
  if (!(await ensureDirectIpConsent(proxyType))) {
    showErrors([
      "A direct profile would send your own public IP to the GeoIP provider. Allow that collection to continue.",
    ]);
    return;
  }
  const response = await request({ type: "profiles:activate", profileId }, parseMutationResponse);
  if (!response.ok) {
    showErrors(response.errors);
    return;
  }
  if (!response.value.ok) {
    showErrors(response.value.errors);
  }
  renderStatus(response.value.state);
  await reload(profileId);
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
  if (!window.confirm(`Delete the profile “${profile.name}”?`)) return;

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

// Event Listeners
ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveProfile();
});

ui.newProfile.addEventListener("click", () => {
  showErrors([]);
  selectProfile(null);
});

async function saveAndActivate(): Promise<void> {
  const profile = await saveProfile();
  if (profile === null) return;
  await activateProfileById(profile.id, profile.proxy.type);
}

ui.saveActivate.addEventListener("click", () => {
  void saveAndActivate();
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
  void activateProfileById(BUILTIN_DIRECT_PROFILE_ID, "direct");
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

ui.latitude.addEventListener("input", () => {
  manualUserEdited = true;
  const lat = parseCoordinate(ui.latitude.value, -MAP_MAX_LATITUDE, MAP_MAX_LATITUDE);
  const lng = parseCoordinate(ui.longitude.value, -180, 180);
  if (lat !== null && lng !== null) {
    const viewport = mapViewport();
    const pos = viewportPoint(viewport, lat, lng);
    if (pos.x < 20 || pos.x > viewport.width - 20 || pos.y < 20 || pos.y > viewport.height - 20) {
      viewportCenter = { latitude: lat, longitude: lng };
    }
  }
  renderLocationMap();
});

ui.longitude.addEventListener("input", () => {
  manualUserEdited = true;
  const lat = parseCoordinate(ui.latitude.value, -MAP_MAX_LATITUDE, MAP_MAX_LATITUDE);
  const lng = parseCoordinate(ui.longitude.value, -180, 180);
  if (lat !== null && lng !== null) {
    const viewport = mapViewport();
    const pos = viewportPoint(viewport, lat, lng);
    if (pos.x < 20 || pos.x > viewport.width - 20 || pos.y < 20 || pos.y > viewport.height - 20) {
      viewportCenter = { latitude: lat, longitude: lng };
    }
  }
  renderLocationMap();
});

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
  ui.modeAuto.checked = false;
  ui.latitude.value = next.latitude;
  ui.longitude.value = next.longitude;
  ui.accuracy.value = next.accuracy;
  ui.timezone.value = next.timezone;
  manualUserEdited = false;
  viewportCenter = { latitude: resolvedSeed.latitude, longitude: resolvedSeed.longitude };
  mapZoom = null;
  updateVisibility();
});

function adjustZoom(delta: number): void {
  const currentZoom = mapViewport().zoom;
  mapZoom = Math.min(18, Math.max(2, currentZoom + delta));
  renderLocationMap();
}

ui.mapZoomIn.addEventListener("click", () => {
  adjustZoom(1);
});

ui.mapZoomOut.addEventListener("click", () => {
  adjustZoom(-1);
});

// Map pointer interactions: background pan vs marker drag vs click
ui.mapMarker.addEventListener("pointerdown", (event) => {
  if (!ui.modeManual.checked) return;
  event.stopPropagation();
  activeDrag = {
    type: "marker",
    originX: event.clientX,
    originY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
  };
  ui.mapMarker.setPointerCapture(event.pointerId);
  ui.mapMarker.classList.add("is-dragging");
});

ui.mapSurface.addEventListener("pointerdown", (event) => {
  if (!ui.modeManual.checked) return;
  if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement) {
    return;
  }
  activeDrag = {
    type: "pan",
    originX: event.clientX,
    originY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
  };
  ui.mapSurface.setPointerCapture(event.pointerId);
  ui.mapSurface.classList.add("is-grabbing");
});

window.addEventListener("pointermove", (event) => {
  if (activeDrag === null) return;

  if (activeDrag.type === "pan") {
    const deltaX = event.clientX - activeDrag.lastX;
    const deltaY = event.clientY - activeDrag.lastY;
    activeDrag.lastX = event.clientX;
    activeDrag.lastY = event.clientY;
    viewportCenter = panViewport(mapViewport(), deltaX, deltaY);
    renderLocationMap();
    return;
  }

  if (activeDrag.type === "marker") {
    const bounds = ui.mapSurface.getBoundingClientRect();
    const cursorX = event.clientX - bounds.left;
    const cursorY = event.clientY - bounds.top;
    const picked = latLngFromViewport(mapViewport(), { x: cursorX, y: cursorY });
    setManualPoint(picked.latitude, picked.longitude, true);
  }
});

window.addEventListener("pointerup", (event) => {
  if (activeDrag === null) return;
  const isPan = activeDrag.type === "pan";
  const distance = Math.hypot(
    event.clientX - activeDrag.originX,
    event.clientY - activeDrag.originY,
  );
  activeDrag = null;
  ui.mapSurface.classList.remove("is-grabbing");
  ui.mapMarker.classList.remove("is-dragging");

  if (isPan && distance <= 4) {
    // Click on map moves marker to clicked location
    const bounds = ui.mapSurface.getBoundingClientRect();
    const clickX = event.clientX - bounds.left;
    const clickY = event.clientY - bounds.top;
    const picked = latLngFromViewport(mapViewport(), { x: clickX, y: clickY });
    setManualPoint(picked.latitude, picked.longitude, true);
  }
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

onRuntimeMessage(async (message) => {
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
