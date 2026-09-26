import { describe, expect, it } from "vitest";
import {
  GUIDE,
  describeRouting,
  explainRuntimeError,
  showFirstRun,
} from "../src/shared/onboarding";

describe("first-run guidance", () => {
  it("shows the introduction only before any profile exists", () => {
    expect(showFirstRun(0)).toBe(true);
    expect(showFirstRun(1)).toBe(false);
  });

  it("says browser routing does not override Firefox's proxy", () => {
    expect(describeRouting(false, "direct")).toContain("does not override");
    expect(describeRouting(true, "http", "127.0.0.1", 8080)).toBe("HTTP 127.0.0.1:8080");
  });

  it("explains automatic location, the map, WebRTC, and failures in the guide", () => {
    const text = GUIDE.map((section) => `${section.title} ${section.body}`).join(" ");
    expect(text).toContain("Automatic");
    expect(text).toContain("Manual");
    expect(text).toContain("20 km");
    expect(text).toContain("map");
    expect(text).toContain("WebRTC");
    expect(text).toContain("password");
    expect(text).toContain("does not turn off a proxy");
  });

  it("adds a next step for consent, provider, and proxy failures", () => {
    expect(explainRuntimeError("consent_required", "Lookup refused.")).toContain("proxied profile");
    expect(explainRuntimeError("provider_error", "Timed out.")).toContain("Refresh Identity");
    expect(explainRuntimeError("proxy_error", "Connection refused.")).toContain("password");
    expect(explainRuntimeError("schema_unsupported", "Left unchanged.")).toContain("newer version");
    expect(explainRuntimeError(undefined, "Saved.")).toBe("Saved.");
  });
});
