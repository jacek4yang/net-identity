/**
 * Options page: profile CRUD.
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
import { describeProxy, type IdentityProfile } from "../profile/schema";
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
import { onRuntimeMessage, request } from "../shared/runtime";
import type { RuntimeState } from "../shared/state";
import {
  credentialsIntentFrom,
  proxyFieldHints,
  toFormValues,
  toProfileInput,
  type ProfileFormValues,
} from "./form";

const ui = {
  list: requireElement<HTMLUListElement>("#profile-list"),
  listEmpty: requireElement<HTMLElement>("#list-empty"),
  newProfile: requireElement<HTMLButtonElement>("#new-profile"),
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
  proxyDns: requireElement<HTMLInputElement>("#field-proxy-dns"),
  bypass: requireElement<HTMLTextAreaElement>("#field-bypass"),
  modeAuto: requireElement<HTMLInputElement>("#field-mode-auto"),
  modeManual: requireElement<HTMLInputElement>("#field-mode-manual"),
  manualFields: requireElement<HTMLElement>("#manual-fields"),
  latitude: requireElement<HTMLInputElement>("#field-latitude"),
  longitude: requireElement<HTMLInputElement>("#field-longitude"),
  accuracy: requireElement<HTMLInputElement>("#field-accuracy"),
  timezone: requireElement<HTMLInputElement>("#field-timezone"),
  webrtc: requireElement<HTMLSelectElement>("#field-webrtc"),
  save: requireElement<HTMLButtonElement>("#save"),
  activate: requireElement<HTMLButtonElement>("#activate"),
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

function updateVisibility(): void {
  const isDirect = ui.proxyType.value === "direct";
  const isManual = ui.modeManual.checked;
  const hasCredentials = selectedId !== null && credentialProfileIds.includes(selectedId);

  ui.proxyAddressFields.hidden = isDirect;
  ui.manualFields.hidden = !isManual;
  ui.removeCredentials.parentElement?.toggleAttribute("hidden", !hasCredentials);

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
  if (isDirect) {
    ui.hints.append(
      el("li", {
        text: "A direct profile does not override a proxy configured in Firefox's own settings.",
      }),
    );
  }
}

function renderProfileList(): void {
  clear(ui.list);
  ui.listEmpty.hidden = profiles.length > 0;

  for (const profile of profiles) {
    const badges: Node[] = [];
    if (profile.id === activeProfileId)
      badges.push(el("span", { className: "badge", text: "active" }));
    if (credentialProfileIds.includes(profile.id)) {
      badges.push(el("span", { className: "badge", text: "session credentials" }));
    }
    if (profile.proxy.type === "direct")
      badges.push(el("span", { className: "badge", text: "direct" }));

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
          text: `${describeProxy(profile.proxy)} · ${profile.identity.mode} identity · WebRTC ${profile.webrtcPolicy}`,
        }),
      ],
    });
    ui.list.append(item);
  }
}

function selectProfile(profileId: string | null): void {
  selectedId = profileId;
  const profile = selectedProfile();
  writeForm(toFormValues(profile));

  ui.formTitle.textContent = profile === null ? "New profile" : profile.name;
  ui.formBadge.hidden = profile === null || profile.id !== activeProfileId;
  ui.formBadge.textContent = "active";

  const hasSelection = profile !== null;
  ui.delete.disabled = !hasSelection;
  ui.duplicate.disabled = !hasSelection;
  ui.activate.disabled = !hasSelection;
  ui.deactivate.disabled = activeProfileId === null;
  renderProfileList();
  updateVisibility();
}

function renderStatus(state: RuntimeState): void {
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
      : null);
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

async function activateSelected(): Promise<void> {
  const profile = await saveProfile();
  if (profile === null) return;
  const response = await request(
    { type: "profiles:activate", profileId: profile.id },
    parseMutationResponse,
  );
  if (!response.ok) {
    showErrors(response.errors);
    return;
  }
  if (!response.value.ok) {
    showErrors(response.value.errors);
  }
  renderStatus(response.value.state);
  await reload(profile.id);
}

async function duplicateSelected(): Promise<void> {
  if (selectedId === null) return;
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
  if (profile === null) return;
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
  selectedId = null;
  renderStatus(response.value.state);
  await reload();
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

ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveProfile();
});

ui.newProfile.addEventListener("click", () => {
  showErrors([]);
  selectProfile(null);
});

ui.activate.addEventListener("click", () => {
  void activateSelected();
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
  updateVisibility();
});

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
