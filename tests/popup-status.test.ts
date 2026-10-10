import { describe, expect, it } from "vitest";
import { describePopupStatus } from "../src/popup/status";
import { createInitialRuntimeState, type RuntimeState } from "../src/shared/state";

function state(overrides: Partial<RuntimeState>): RuntimeState {
  return { ...createInitialRuntimeState(0), status: "ready", appliedRoute: "proxy", ...overrides };
}

describe("popup network health status", () => {
  it("labels uncertain evidence honestly, including during recovery", () => {
    for (const message of ["Repeated requests failed", "Waiting for sustained recovery"]) {
      expect(
        describePopupStatus(
          state({ runtimeHealth: "degraded", lastError: { code: "proxy_suspect", message } }),
        ),
      ).toEqual({ label: "Proxy connection uncertain", tone: "warn" });
    }
  });

  it("does not mislabel other degraded causes or a healthy recovery", () => {
    expect(
      describePopupStatus(
        state({
          runtimeHealth: "degraded",
          lastError: { code: "provider_error", message: "GeoIP failed" },
        }),
      ).label,
    ).toBe("Active");
    expect(
      describePopupStatus(
        state({
          runtimeHealth: "healthy",
          lastError: { code: "proxy_recovered", message: "Recovered" },
        }),
      ).label,
    ).toBe("Active");
    expect(
      describePopupStatus(
        state({ runtimeHealth: "healthy", lastError: { code: "proxy_suspect", message: "Stale" } }),
      ).label,
    ).toBe("Active");
  });

  it("preserves credential, blocking and lifecycle status priorities", () => {
    expect(describePopupStatus(state({ runtimeHealth: "credentials_required" })).label).toBe(
      "Credentials required",
    );
    expect(describePopupStatus(state({ appliedRoute: "blocked" })).label).toBe("Routing blocked");
    expect(describePopupStatus("deactivating")).toEqual({ label: "Turning off…", tone: "pending" });
    expect(describePopupStatus("idle")).toEqual({ label: "Off", tone: "pending" });
    expect(describePopupStatus("activating").label).toBe("Activating…");
  });
});
