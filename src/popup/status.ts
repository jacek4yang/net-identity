/** Pure popup status copy: do not present uncertain network evidence as an outage. */
import type { RuntimeState, RuntimeStatus } from "../shared/state";

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

export function describePopupStatus(state: RuntimeState | RuntimeStatus): {
  label: string;
  tone: string;
} {
  const status = typeof state === "string" ? state : state.status;
  if (typeof state !== "string") {
    if (state.runtimeHealth === "unavailable") return { label: "Proxy unavailable", tone: "bad" };
    if (state.runtimeHealth === "credentials_required")
      return { label: "Credentials required", tone: "bad" };
    if (state.appliedRoute === "blocked") return { label: "Routing blocked", tone: "bad" };
    if (state.runtimeHealth === "degraded" && state.lastError?.code === "proxy_suspect")
      return { label: "Proxy connection uncertain", tone: "warn" };
  }
  return { label: LIFECYCLE_LABELS[status], tone: LIFECYCLE_TONES[status] };
}
