/**
 * Popup view: a small, high-information status surface.
 *
 * Rendering is plain DOM with `textContent` only (never `innerHTML`), no remote
 * assets and no framework. Every response from the background script is parsed
 * before use.
 */
import type { AuditCheckStatus, AuditVerdict } from "../shared/audit";
import { clear, el, formatAccuracy, formatCoordinates, requireElement } from "../shared/dom";
import {
  parseMutationResponse,
  parseOutboundMessage,
  parseProfilesResponse,
  parseStateResponse,
  type MutationResponse,
  type ProfilesResponse,
} from "../shared/messages";
import { onRuntimeMessage, openOptionsPage, request } from "../shared/runtime";
import type { RuntimeState, RuntimeStatus, WebRtcApplyStatus } from "../shared/state";

const elements = {
  statusChip: requireElement<HTMLElement>("#status-chip"),
  verdictChip: requireElement<HTMLElement>("#verdict-chip"),
  activeProfile: requireElement<HTMLElement>("#active-profile"),
  proxySummary: requireElement<HTMLElement>("#proxy-summary"),
  publicIp: requireElement<HTMLElement>("#public-ip"),
  location: requireElement<HTMLElement>("#location"),
  timezone: requireElement<HTMLElement>("#timezone"),
  coordinates: requireElement<HTMLElement>("#coordinates"),
  webrtc: requireElement<HTMLElement>("#webrtc"),
  auditChecks: requireElement<HTMLUListElement>("#audit-checks"),
  errorBox: requireElement<HTMLElement>("#error-box"),
  profileSelect: requireElement<HTMLSelectElement>("#profile-select"),
  activateButton: requireElement<HTMLButtonElement>("#activate"),
  refreshButton: requireElement<HTMLButtonElement>("#refresh"),
  manageButton: requireElement<HTMLButtonElement>("#manage"),
};

const LIFECYCLE_LABELS: Record<RuntimeStatus, string> = {
  idle: "Inactive",
  activating: "Activating",
  resolving: "Resolving",
  ready: "Active",
  error: "Error",
};

const LIFECYCLE_TONES: Record<RuntimeStatus, string> = {
  idle: "pending",
  activating: "pending",
  resolving: "pending",
  ready: "ok",
  error: "bad",
};

/** User-facing wording for the audit verdict; deliberately not "anonymous"/"undetectable". */
const VERDICT_LABELS: Record<AuditVerdict, string> = {
  inactive: "Not applying an identity",
  consistent: "Consistent",
  partial: "Partially consistent",
  error: "Error",
};

const VERDICT_TONES: Record<AuditVerdict, string> = {
  inactive: "pending",
  consistent: "ok",
  partial: "warn",
  error: "bad",
};

const CHECK_STATUS_LABELS: Record<AuditCheckStatus, string> = {
  ok: "ok",
  not_configured: "not configured",
  unavailable: "unavailable",
  manual: "manual",
  provider_error: "provider error",
  controlled_by_other_extension: "controlled by another extension",
  stale: "stale",
  pending: "pending",
  error: "error",
};

const WEBRTC_STATUS_LABELS: Record<WebRtcApplyStatus, string> = {
  pending: "pending",
  applied: "applied",
  already: "already set",
  controlled_by_other: "another extension controls it",
  not_controllable: "not controllable in this build",
  unsupported: "rejected by Firefox",
  error: "error",
};

function setChip(element: HTMLElement, text: string, tone: string): void {
  element.textContent = text;
  element.dataset.tone = tone;
}

function renderError(message: string | null): void {
  if (message === null) {
    elements.errorBox.hidden = true;
    elements.errorBox.textContent = "";
    return;
  }
  elements.errorBox.hidden = false;
  elements.errorBox.textContent = message;
}

function renderIdentity(state: RuntimeState): void {
  const identity = state.identity;

  elements.publicIp.textContent = identity.publicIp ?? "—";
  if (identity.publicIp !== undefined && !identity.publicIpVerified) {
    elements.publicIp.textContent = `${identity.publicIp} (not verified)`;
  }

  const place = [identity.city, identity.region, identity.countryCode].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  elements.location.textContent = place.length === 0 ? "—" : place.join(", ");

  elements.timezone.textContent = identity.timezone ?? "—";

  elements.coordinates.textContent =
    identity.latitude === undefined || identity.longitude === undefined
      ? "—"
      : `${formatCoordinates(identity.latitude, identity.longitude)} (${formatAccuracy(identity.accuracy)})`;

  const webrtc = state.webrtc;
  elements.webrtc.textContent =
    webrtc.status === "applied" || webrtc.status === "already"
      ? webrtc.desired
      : `${webrtc.desired} — ${WEBRTC_STATUS_LABELS[webrtc.status]}`;
}

function renderAudit(state: RuntimeState): void {
  clear(elements.auditChecks);
  for (const check of state.audit.checks) {
    const status = el("span", {
      className: "check-status",
      text: CHECK_STATUS_LABELS[check.status],
      ...(check.detail === undefined ? {} : { title: check.detail }),
    });
    const item = el("li", {
      attrs: { "data-status": check.status },
      children: [el("span", { className: "check-label", text: check.label }), status],
    });
    elements.auditChecks.append(item);
  }
}

function renderProfiles(profiles: ProfilesResponse | null): void {
  if (profiles === null) return;
  const previous = elements.profileSelect.value;
  clear(elements.profileSelect);

  for (const profile of profiles.profiles) {
    const active = profile.id === profiles.activeProfileId ? " (active)" : "";
    elements.profileSelect.append(
      el("option", { value: profile.id, text: `${profile.name}${active}` }),
    );
  }

  const desired = previous !== "" ? previous : (profiles.activeProfileId ?? "");
  if (desired !== "") elements.profileSelect.value = desired;

  const selected = elements.profileSelect.value;
  elements.activateButton.disabled = selected === "" || selected === profiles.activeProfileId;
}

function renderState(state: RuntimeState): void {
  setChip(elements.statusChip, LIFECYCLE_LABELS[state.status], LIFECYCLE_TONES[state.status]);
  setChip(
    elements.verdictChip,
    VERDICT_LABELS[state.audit.verdict],
    VERDICT_TONES[state.audit.verdict],
  );

  elements.activeProfile.textContent = state.activeProfileName ?? "No profile active";

  const proxy = state.proxy;
  elements.proxySummary.textContent = proxy.configured
    ? `${proxy.type.toUpperCase()} ${proxy.host ?? "?"}:${proxy.port ?? "?"}`
    : "Direct connection";

  renderIdentity(state);
  renderAudit(state);
  renderError(state.lastError === undefined ? null : state.lastError.message);
  elements.refreshButton.disabled = state.activeProfileId === null;
}

function applyMutation(result: MutationResponse, profiles: ProfilesResponse | null): void {
  renderState(result.state);
  renderProfiles(profiles);
  if (!result.ok && result.errors.length > 0) renderError(result.errors.join("; "));
}

async function loadProfiles(): Promise<ProfilesResponse | null> {
  const response = await request({ type: "profiles:list" }, parseProfilesResponse);
  if (!response.ok) {
    renderError(response.errors.join("; "));
    return null;
  }
  renderProfiles(response.value);
  return response.value;
}

async function activateSelectedProfile(): Promise<void> {
  const profileId = elements.profileSelect.value;
  if (profileId === "") return;
  elements.activateButton.disabled = true;
  const response = await request({ type: "profiles:activate", profileId }, parseMutationResponse);
  if (!response.ok) {
    renderError(response.errors.join("; "));
    elements.activateButton.disabled = false;
    return;
  }
  await loadProfiles();
  applyMutation(response.value, null);
}

async function refreshIdentity(): Promise<void> {
  elements.refreshButton.disabled = true;
  const response = await request({ type: "identity:refresh" }, parseMutationResponse);
  if (!response.ok) {
    renderError(response.errors.join("; "));
    elements.refreshButton.disabled = false;
    return;
  }
  applyMutation(response.value, null);
}

async function bootstrap(): Promise<void> {
  const [stateResponse, profiles] = await Promise.all([
    request({ type: "state:get" }, parseStateResponse),
    loadProfiles(),
  ]);

  if (!stateResponse.ok) {
    renderError(stateResponse.errors.join("; "));
    return;
  }
  renderState(stateResponse.value.state);
  renderProfiles(profiles);
}

elements.activateButton.addEventListener("click", () => {
  void activateSelectedProfile();
});

elements.refreshButton.addEventListener("click", () => {
  void refreshIdentity();
});

elements.manageButton.addEventListener("click", () => {
  void openOptionsPage();
});

elements.profileSelect.addEventListener("change", () => {
  void loadProfiles();
});

onRuntimeMessage(async (message) => {
  const parsed = parseOutboundMessage(message);
  if (!parsed.ok) return undefined;
  if (parsed.value.type === "state:changed") {
    renderState(parsed.value.state);
    return undefined;
  }
  return undefined;
});

void bootstrap();
