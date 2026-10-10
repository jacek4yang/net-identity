import { bindVaultControls } from "../shared/vault-ui";
import { bindLanguageControl } from "../shared/language-control";
import { localizeKnownText as lt, message, formatMessage } from "../shared/i18n";
import { filterProfiles } from "./profile-search";
import { bindQuickAdd } from "./quick-add";
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
import { describePopupStatus } from "./status";

const elements = {
  statusPill: requireElement<HTMLElement>("#status-pill"),
  statusText: requireElement<HTMLElement>("#status-text"),
  consistencyBadge: requireElement<HTMLElement>("#consistency-badge"),
  routeOff: requireElement<HTMLButtonElement>("#route-off"),
  routeList: requireElement<HTMLElement>("#route-list"),
  routeSearch: requireElement<HTMLInputElement>("#route-search"),
  routeEmpty: requireElement<HTMLElement>("#route-empty"),
  manageProfiles: requireElement<HTMLButtonElement>("#manage-profiles"),
  identityRoute: requireElement<HTMLElement>("#identity-route"),
  identityIp: requireElement<HTMLElement>("#identity-ip"),
  identityLocation: requireElement<HTMLElement>("#identity-location"),
  identityTimezone: requireElement<HTMLElement>("#identity-timezone"),
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

let lastState: RuntimeState | undefined;
let quickAddBusy = false;
let knownProfiles: IdentityProfile[] = [];
let currentActiveId: string | null = null;
let currentStatus: RuntimeStatus = "idle";
let activatingProfileId: string | null = null;
let isDeactivating = false;
let displayedGeneration = -1;

function setStatusPill(state: RuntimeState | RuntimeStatus | "deactivating"): void {
  const { label, tone } = describePopupStatus(state);
  elements.statusText.textContent = lt(label);
  elements.statusPill.dataset.tone = tone;
}

function renderError(message: string | null): void {
  if (message === null) {
    elements.errorBox.hidden = true;
    elements.errorBox.textContent = "";
    return;
  }
  elements.errorBox.hidden = false;
  elements.errorBox.textContent = lt(message);
}

function describeEndpoint(state: RuntimeState): string {
  if (state.activeProfileId === null) return "No proxy active";
  if (state.proxy.type === "direct") return "Direct (Firefox / system routing)";
  return `${state.proxy.type.toUpperCase()} ${state.proxy.host ?? "unknown"}:${String(state.proxy.port ?? "")}`;
}

function renderRoutes(): void {
  const isOff = currentActiveId === null && currentStatus === "idle" && !activatingProfileId;
  elements.routeOff.setAttribute("aria-checked", String(isOff));
  elements.routeOff.classList.toggle("is-activating", isDeactivating);

  elements.routeOff.disabled = quickAddBusy;
  clear(elements.routeList);

  const matches = filterProfiles(
    knownProfiles,
    elements.routeSearch.value,
    message("browserRouting"),
  );
  elements.routeEmpty.hidden = matches.length > 0;
  for (const profile of matches) {
    const isDirect = isBuiltinDirectProfile(profile.id);
    const isActive = profile.id === currentActiveId;
    const isThisActivating = profile.id === activatingProfileId;

    const secondaryText = isDirect
      ? message("browserRoutingExplanation")
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
            el("span", {
              className: "route-name",
              text: isDirect ? message("browserRouting") : profile.name,
            }),
            el("span", { className: "route-desc", text: lt(secondaryText) }),
          ],
        }),
        el("div", {
          className: "route-tail",
          attrs: { "aria-hidden": "true" },
          children: [el("span", { className: "route-indicator" })],
        }),
      ],
    });

    item.disabled = quickAddBusy;
    elements.routeList.append(item);
  }
}

function renderIdentity(state: RuntimeState): void {
  const identity = state.identity;
  const isIdle = state.status === "idle";

  elements.identityRoute.textContent = isIdle
    ? message("noneOff")
    : (state.activeProfileName ??
      (state.activeProfileId === null ? message("routingBlocked") : message("browserRouting")));

  if (isIdle) {
    elements.identityIp.textContent = "—";
    elements.identityLocation.textContent = "—";
    elements.identityTimezone.textContent = "—";
  } else {
    elements.identityIp.textContent = identity.publicIp
      ? `${identity.publicIp}${identity.publicIpVerified ? "" : " (unverified)"}`
      : "—";

    const parts = [identity.city, identity.region, identity.countryCode].filter(
      (part): part is string => typeof part === "string" && part !== "",
    );
    elements.identityLocation.textContent = parts.length > 0 ? parts.join(", ") : "—";
    elements.identityTimezone.textContent = identity.timezone ?? "—";
  }

  // Consistency badge
  const verdict = isIdle ? "inactive" : state.audit.verdict;
  elements.consistencyBadge.textContent = lt(VERDICT_LABELS[verdict] ?? verdict);
  elements.consistencyBadge.dataset.tone = VERDICT_TONES[verdict] ?? "pending";
}

function renderDetails(state: RuntimeState): void {
  elements.detailsEndpoint.textContent = lt(describeEndpoint(state));

  elements.detailsIpVerified.textContent =
    state.status === "idle"
      ? message("noRoute")
      : state.identity.publicIpVerified
        ? message("verified")
        : message("unverified");

  elements.detailsFirefoxProxy.textContent = formatMessage("firefoxProxyDetail", {
    type: state.firefoxProxy.proxyType,
    control: state.firefoxProxy.levelOfControl,
  });

  elements.detailsCoordinates.textContent =
    state.identity.latitude !== undefined && state.identity.longitude !== undefined
      ? `${formatCoordinates(state.identity.latitude, state.identity.longitude)} (${formatAccuracy(state.identity.accuracy)})`
      : "—";

  elements.detailsWebrtcDetail.textContent = formatMessage("webrtcDetail", {
    desired: state.webrtc.desired,
    actual: state.webrtc.actual ?? "default",
    status: state.webrtc.status,
  });

  elements.detailsFrames.textContent = state.content.hasShim
    ? formatMessage("framesSynced", {
        current: state.content.currentFrameCount ?? "?",
        total: state.content.frameCount ?? "?",
      })
    : message("noTabs");

  // Detailed audit checks
  clear(elements.auditChecks);
  for (const check of state.audit.checks) {
    const item = el("li", {
      className: "audit-item",
      children: [
        el("span", { className: "audit-item-label", text: lt(check.label) }),
        el("span", {
          className: "audit-item-status",
          attrs: { "data-status": check.status, title: lt(check.detail ?? "") },
          text: lt(CHECK_STATUS_LABELS[check.status] ?? check.status),
        }),
      ],
    });
    elements.auditChecks.append(item);
  }
}

function renderState(state: RuntimeState): void {
  if (state.generation < displayedGeneration) return;
  lastState = state;
  displayedGeneration = state.generation;
  currentStatus = state.status;
  currentActiveId = state.activeProfileId;
  activatingProfileId = null;
  isDeactivating = false;

  setStatusPill(state);
  renderIdentity(state);
  renderDetails(state);
  renderRoutes();

  elements.refreshButton.disabled = quickAddBusy || state.activeProfileId === null;

  renderError(
    state.runtimeHealth === "credentials_required"
      ? "Proxy credentials are required. Traffic remains restricted to this profile."
      : state.runtimeHealth === "unavailable"
        ? "Traffic is blocked rather than sent directly. Retry this profile after the proxy returns."
        : state.lastError === undefined || state.lastError.code === "proxy_recovered"
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
    renderError(result.errors.map(lt).join("; "));
  }
}

async function loadProfiles(): Promise<ProfilesResponse | null> {
  const response = await request({ type: "profiles:list" }, parseProfilesResponse);
  if (!response.ok) {
    renderError(response.errors.map(lt).join("; "));
    return null;
  }
  knownProfiles = response.value.profiles;
  renderRoutes();
  return response.value;
}

async function activateRoute(profileId: string): Promise<void> {
  const target = knownProfiles.find((p) => p.id === profileId);
  if (target === undefined) return;

  activatingProfileId = profileId;
  setStatusPill("activating");
  renderRoutes();
  renderError(null);

  const response = await request({ type: "profiles:activate", profileId }, parseMutationResponse);
  if (!response.ok) {
    renderError(response.errors.map(lt).join("; "));
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
  // Off is only truthful after the background commits teardown.
  setStatusPill("deactivating");
  renderRoutes();
  renderError(null);

  const response = await request({ type: "profiles:deactivate" }, parseMutationResponse);
  if (!response.ok) {
    renderError(response.errors.map(lt).join("; "));
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
    renderError(response.errors.map(lt).join("; "));
    setStatusPill(currentStatus);
    return;
  }

  applyMutation(response.value, null);
}

function toggleDetailsVisibility(): void {
  const isHidden = elements.detailsPanel.hidden;
  elements.detailsPanel.hidden = !isHidden;
  elements.toggleDetails.setAttribute("aria-expanded", String(isHidden));
  elements.toggleDetails.textContent = isHidden ? message("hideDetails") : message("details");
}

async function bootstrap(): Promise<void> {
  await bindLanguageControl(() => {
    if (lastState) renderState(lastState);
    elements.toggleDetails.textContent = elements.detailsPanel.hidden
      ? message("details")
      : message("hideDetails");
  });
  if (!(await bindVaultControls())) return;
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

// Arrow keys move between routes; Enter/Space retain native button activation.
requireElement<HTMLElement>(".routes-container").addEventListener("keydown", (event) => {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const rows = [
    elements.routeOff,
    ...elements.routeList.querySelectorAll<HTMLButtonElement>("button"),
  ];
  const index = rows.findIndex((row) => row === document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
  rows[next]?.focus();
});

// Filtering is display-only and never changes the selected route.
elements.routeSearch.addEventListener("input", renderRoutes);

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

onRuntimeMessage((message) => {
  const parsed = parseOutboundMessage(message);
  if (!parsed.ok) return undefined;
  if (parsed.value.type === "state:changed") {
    renderState(parsed.value.state);
    return undefined;
  }
  return undefined;
});

bindQuickAdd({
  profiles: () => knownProfiles,
  reload: loadProfiles,
  activate: activateRoute,
  busy: (value) => {
    quickAddBusy = value;
    elements.refreshButton.disabled = value || currentActiveId === null;
    renderRoutes();
  },
});

void bootstrap();
