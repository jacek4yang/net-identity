/**
 * Popup view: compact quick-switching route switcher and identity surface.
 *
 * Normal usage requires ONE click to switch routes (Direct or a proxy profile).
 * Rendering uses plain DOM with textContent only (never innerHTML), no remote assets
 * and no framework.
 */
import type { AuditCheckStatus, AuditVerdict } from "../shared/audit";
import { formatAccuracy, formatCoordinates, requireElement, clear, el } from "../shared/dom";
import {
  parseMutationResponse,
  parseOutboundMessage,
  parseProfilesResponse,
  parseStateResponse,
  type MutationResponse,
  type ProfilesResponse,
} from "../shared/messages";
import {
  ensureDirectIpConsent,
  onRuntimeMessage,
  openOptionsPage,
  request,
} from "../shared/runtime";
import type { RuntimeState, RuntimeStatus } from "../shared/state";
import { isBuiltinDirectProfile, type IdentityProfile } from "../profile/schema";
import { explainRuntimeError } from "../shared/onboarding";

const elements = {
  statusPill: requireElement<HTMLElement>("#status-pill"),
  statusText: requireElement<HTMLElement>("#status-text"),
  consistencyBadge: requireElement<HTMLElement>("#consistency-badge"),
  routeOff: requireElement<HTMLButtonElement>("#route-off"),
  routeList: requireElement<HTMLElement>("#route-list"),
  manageProfiles: requireElement<HTMLButtonElement>("#manage-profiles"),
  identityRoute: requireElement<HTMLElement>("#identity-route"),
  identityIp: requireElement<HTMLElement>("#identity-ip"),
  identityLocation: requireElement<HTMLElement>("#identity-location"),
  identityTimezone: requireElement<HTMLElement>("#identity-timezone"),
  identityWebrtc: requireElement<HTMLElement>("#identity-webrtc"),
  refreshButton: requireElement<HTMLButtonElement>("#refresh-button"),
  toggleDetails: requireElement<HTMLButtonElement>("#toggle-details"),
  errorBox: requireElement<HTMLElement>("#error-box"),
  detailsPanel: requireElement<HTMLElement>("#details-panel"),
  detailsEndpoint: requireElement<HTMLElement>("#details-endpoint"),
  detailsIpVerified: requireElement<HTMLElement>("#details-ip-verified"),
  detailsFirefoxProxy: requireElement<HTMLElement>("#details-firefox-proxy"),
  detailsCoordinates: requireElement<HTMLElement>("#details-coordinates"),
  detailsWebrtcDetail: requireElement<HTMLElement>("#details-webrtc-detail"),
  detailsFrames: requireElement<HTMLElement>("#details-frames"),
  auditChecks: requireElement<HTMLUListElement>("#audit-checks"),
};

const LIFECYCLE_LABELS: Record<RuntimeStatus, string> = {
  idle: "Off",
  activating: "Activating…",
  resolving: "Resolving…",
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

const VERDICT_LABELS: Record<AuditVerdict, string> = {
  inactive: "Inactive",
  consistent: "✓ Consistent",
  partial: "Partial",
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

let knownProfiles: IdentityProfile[] = [];
let currentActiveId: string | null = null;
let currentStatus: RuntimeStatus = "idle";
let activatingProfileId: string | null = null;
let isDeactivating = false;

function setStatusPill(status: RuntimeStatus): void {
  const label = LIFECYCLE_LABELS[status] ?? status;
  const tone = LIFECYCLE_TONES[status] ?? "pending";
  elements.statusText.textContent = label;
  elements.statusPill.dataset.tone = tone;
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

function describeEndpoint(profile: IdentityProfile | null, state: RuntimeState): string {
  if (state.status === "idle" || profile === null) return "No proxy active";
  if (profile.proxy.type === "direct") return "Direct (browser / system)";
  return `${profile.proxy.type.toUpperCase()} · ${profile.proxy.host ?? "unknown"}:${String(profile.proxy.port ?? "")}`;
}

function describeWebRtcConcise(state: RuntimeState): string {
  if (state.status === "idle") return "Native / default";
  const webrtc = state.webrtc;
  if (webrtc.desired === "default") return "Default (unmodified)";
  if (webrtc.status === "applied" || webrtc.status === "already") {
    return `Protected (${webrtc.desired})`;
  }
  return `${webrtc.desired} (${webrtc.status})`;
}

function renderRoutes(): void {
  const isOff = currentActiveId === null && !activatingProfileId;
  elements.routeOff.setAttribute("aria-checked", String(isOff));
  elements.routeOff.classList.toggle("is-activating", isDeactivating);

  clear(elements.routeList);

  for (const profile of knownProfiles) {
    const isDirect = isBuiltinDirectProfile(profile.id);
    const isActive = profile.id === currentActiveId;
    const isThisActivating = profile.id === activatingProfileId;

    const secondaryText = isDirect
      ? "Browser / system routing"
      : `${profile.proxy.type.toUpperCase()} · ${profile.proxy.host ?? ""}:${String(profile.proxy.port ?? "")}`;

    const leadIcon = isDirect ? "🌐" : "🛡️";

    const item = el("button", {
      className: `route-item${isThisActivating ? " is-activating" : ""}`,
      attrs: {
        role: "radio",
        "aria-checked": String(isActive),
        "data-profile-id": profile.id,
        tabindex: "0",
      },
      onClick: () => {
        void activateRoute(profile.id);
      },
      children: [
        el("div", {
          className: "route-lead",
          attrs: { "aria-hidden": "true" },
          children: [el("span", { text: leadIcon })],
        }),
        el("div", {
          className: "route-body",
          children: [
            el("span", { className: "route-name", text: profile.name }),
            el("span", { className: "route-desc", text: secondaryText }),
          ],
        }),
        el("div", {
          className: "route-tail",
          attrs: { "aria-hidden": "true" },
          children: [el("span", { className: "route-indicator" })],
        }),
      ],
    });

    elements.routeList.append(item);
  }
}

function renderIdentity(state: RuntimeState): void {
  const identity = state.identity;
  const isIdle = state.status === "idle";

  elements.identityRoute.textContent = isIdle
    ? "None (Off)"
    : (state.activeProfileName ?? "Direct");

  if (isIdle) {
    elements.identityIp.textContent = "—";
    elements.identityLocation.textContent = "—";
    elements.identityTimezone.textContent = "—";
    elements.identityWebrtc.textContent = "Default";
  } else {
    elements.identityIp.textContent = identity.publicIp
      ? `${identity.publicIp}${identity.publicIpVerified ? "" : " (unverified)"}`
      : "—";

    const parts = [identity.city, identity.region, identity.countryCode].filter(
      (part): part is string => typeof part === "string" && part !== "",
    );
    elements.identityLocation.textContent = parts.length > 0 ? parts.join(", ") : "—";
    elements.identityTimezone.textContent = identity.timezone ?? "—";
    elements.identityWebrtc.textContent = describeWebRtcConcise(state);
  }

  // Consistency badge
  const verdict = isIdle ? "inactive" : state.audit.verdict;
  elements.consistencyBadge.textContent = VERDICT_LABELS[verdict] ?? verdict;
  elements.consistencyBadge.dataset.tone = VERDICT_TONES[verdict] ?? "pending";
}

function renderDetails(state: RuntimeState): void {
  const activeProfile = knownProfiles.find((p) => p.id === state.activeProfileId) ?? null;
  elements.detailsEndpoint.textContent = describeEndpoint(activeProfile, state);

  elements.detailsIpVerified.textContent =
    state.status === "idle"
      ? "No route active"
      : state.identity.publicIpVerified
        ? "Verified via egress query"
        : "Unverified";

  elements.detailsFirefoxProxy.textContent = `proxyType=${state.firefoxProxy.proxyType} (${state.firefoxProxy.levelOfControl})`;

  elements.detailsCoordinates.textContent =
    state.identity.latitude !== undefined && state.identity.longitude !== undefined
      ? `${formatCoordinates(state.identity.latitude, state.identity.longitude)} (${formatAccuracy(state.identity.accuracy)})`
      : "—";

  elements.detailsWebrtcDetail.textContent = `desired=${state.webrtc.desired}, actual=${state.webrtc.actual ?? "default"} (${state.webrtc.status})`;

  elements.detailsFrames.textContent = state.content.hasShim
    ? `${String(state.content.currentFrameCount)}/${String(state.content.frameCount)} frames synced`
    : "No open tabs reporting";

  // Detailed audit checks
  clear(elements.auditChecks);
  for (const check of state.audit.checks) {
    const item = el("li", {
      className: "audit-item",
      children: [
        el("span", { className: "audit-item-label", text: check.label }),
        el("span", {
          className: "audit-item-status",
          attrs: { "data-status": check.status, title: check.detail ?? "" },
          text: CHECK_STATUS_LABELS[check.status] ?? check.status,
        }),
      ],
    });
    elements.auditChecks.append(item);
  }
}

function renderState(state: RuntimeState): void {
  currentStatus = state.status;
  currentActiveId = state.activeProfileId;
  activatingProfileId = null;
  isDeactivating = false;

  setStatusPill(state.status);
  renderIdentity(state);
  renderDetails(state);
  renderRoutes();

  elements.refreshButton.disabled = state.activeProfileId === null;

  renderError(
    state.lastError === undefined
      ? null
      : explainRuntimeError(state.lastError.code, state.lastError.message),
  );
}

function applyMutation(result: MutationResponse, profiles: ProfilesResponse | null): void {
  renderState(result.state);
  if (profiles !== null) {
    knownProfiles = profiles.profiles;
    renderRoutes();
  }
  if (!result.ok && result.errors.length > 0) {
    renderError(result.errors.join("; "));
  }
}

async function loadProfiles(): Promise<ProfilesResponse | null> {
  const response = await request({ type: "profiles:list" }, parseProfilesResponse);
  if (!response.ok) {
    renderError(response.errors.join("; "));
    return null;
  }
  knownProfiles = response.value.profiles;
  renderRoutes();
  return response.value;
}

async function activateRoute(profileId: string): Promise<void> {
  if (profileId === currentActiveId && currentStatus === "ready") {
    return;
  }
  const target = knownProfiles.find((p) => p.id === profileId);
  if (target === undefined) return;

  if (target.proxy.type === "direct") {
    if (!(await ensureDirectIpConsent("direct"))) {
      renderError(
        "A direct profile sends your own public IP to the GeoIP provider. Allow personal-data collection to proceed.",
      );
      return;
    }
  }

  activatingProfileId = profileId;
  setStatusPill("activating");
  renderRoutes();
  renderError(null);

  const response = await request({ type: "profiles:activate", profileId }, parseMutationResponse);
  if (!response.ok) {
    renderError(response.errors.join("; "));
    activatingProfileId = null;
    setStatusPill(currentStatus);
    renderRoutes();
    return;
  }

  await loadProfiles();
  applyMutation(response.value, null);
}

async function deactivateRoute(): Promise<void> {
  if (currentActiveId === null && currentStatus === "idle") {
    return;
  }

  isDeactivating = true;
  setStatusPill("idle");
  renderRoutes();
  renderError(null);

  const response = await request({ type: "profiles:deactivate" }, parseMutationResponse);
  if (!response.ok) {
    renderError(response.errors.join("; "));
    isDeactivating = false;
    setStatusPill(currentStatus);
    renderRoutes();
    return;
  }

  await loadProfiles();
  applyMutation(response.value, null);
}

async function refreshIdentity(): Promise<void> {
  const activeProfile = knownProfiles.find((p) => p.id === currentActiveId);
  if (activeProfile?.proxy.type === "direct") {
    if (!(await ensureDirectIpConsent("direct"))) {
      renderError(
        "Refreshing a direct profile sends your public IP to the GeoIP provider. Allow collection to continue.",
      );
      return;
    }
  }

  elements.refreshButton.disabled = true;
  setStatusPill("resolving");

  const response = await request({ type: "identity:refresh" }, parseMutationResponse);
  elements.refreshButton.disabled = false;

  if (!response.ok) {
    renderError(response.errors.join("; "));
    setStatusPill(currentStatus);
    return;
  }

  applyMutation(response.value, null);
}

function toggleDetailsVisibility(): void {
  const isHidden = elements.detailsPanel.hidden;
  elements.detailsPanel.hidden = !isHidden;
  elements.toggleDetails.setAttribute("aria-expanded", String(isHidden));
  elements.toggleDetails.textContent = isHidden ? "Hide details" : "Details";
}

async function bootstrap(): Promise<void> {
  const [stateResponse, profilesResponse] = await Promise.all([
    request({ type: "state:get" }, parseStateResponse),
    loadProfiles(),
  ]);

  if (!stateResponse.ok) {
    renderError(stateResponse.errors.join("; "));
    return;
  }

  if (profilesResponse !== null) {
    knownProfiles = profilesResponse.profiles;
  }
  renderState(stateResponse.value.state);
}

// Event bindings
elements.routeOff.addEventListener("click", () => {
  void deactivateRoute();
});

elements.manageProfiles.addEventListener("click", () => {
  void openOptionsPage();
});

elements.refreshButton.addEventListener("click", () => {
  void refreshIdentity();
});

elements.toggleDetails.addEventListener("click", () => {
  toggleDetailsVisibility();
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
