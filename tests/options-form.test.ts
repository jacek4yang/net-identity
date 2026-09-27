import { describe, expect, it } from "vitest";
import {
  credentialsIntentFrom,
  formatBypassHostsInput,
  isCredentialsSupported,
  parseBypassHostsInput,
  proxyFieldHints,
  toFormValues,
  toProfileInput,
  type ProfileFormValues,
} from "../src/options/form";
import { parseProfile } from "../src/profile/validation";
import { SCHEMA_VERSION } from "../src/profile/schema";
import { makeProfile } from "./helpers";

function formValues(overrides: Partial<ProfileFormValues> = {}): ProfileFormValues {
  return {
    id: "profile-0001",
    name: "Office",
    proxyType: "http",
    proxyHost: "127.0.0.1",
    proxyPort: "8080",
    proxyUsername: "user",
    password: "",
    removeCredentials: false,
    proxyDns: false,
    bypassHosts: "localhost\n*.example.com, 10.0.0.0/8",
    identityMode: "auto",
    latitude: "",
    longitude: "",
    accuracy: "1000",
    timezone: "",
    webrtcPolicy: "disable_non_proxied_udp",
    ...overrides,
  };
}

describe("parseBypassHostsInput", () => {
  it("splits on newlines, commas and semicolons and normalises entries", () => {
    expect(parseBypassHostsInput("localhost\n127.0.0.1; EXAMPLE.com,10.0.0.0/8")).toEqual([
      "localhost",
      "127.0.0.1",
      "example.com",
      "10.0.0.0/8",
    ]);
  });

  it("ignores blank lines", () => {
    expect(parseBypassHostsInput("\n\n  \n")).toEqual([]);
  });

  it("round-trips through the textarea format", () => {
    const hosts = ["localhost", "*.example.com"];
    expect(parseBypassHostsInput(formatBypassHostsInput(hosts))).toEqual(hosts);
  });
});

describe("toProfileInput", () => {
  it("preserves independent expert policies even when the legacy mode is auto", () => {
    const profile = makeProfile({
      id: "independent-form",
      identity: {
        mode: "auto",
        geoIpPolicy: "disabled",
        geolocationPolicy: "disabled",
        timezonePolicy: "manual",
        timezone: "UTC",
      },
    });
    const form = toFormValues(profile);
    expect(form.identityMode).toBe("manual");
    const parsed = parseProfile(toProfileInput(form, profile.id));
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        identity: {
          geoIpPolicy: "disabled",
          geolocationPolicy: "disabled",
          timezonePolicy: "manual",
          timezone: "UTC",
        },
      },
    });
  });
  it("converts a proxied form into a valid profile", () => {
    const parsed = parseProfile(toProfileInput(formValues(), "profile-0001"));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.proxy).toEqual({
      type: "http",
      host: "127.0.0.1",
      port: 8080,
      username: "user",
      proxyDNS: false,
      bypassHosts: ["localhost", "*.example.com", "10.0.0.0/8"],
    });
    expect(parsed.value.identity).toMatchObject({ mode: "auto" });
    expect(parsed.value.webrtcPolicy).toBe("disable_non_proxied_udp");
  });

  it("omits host, port and username for a direct profile", () => {
    const parsed = parseProfile(
      toProfileInput(
        formValues({ proxyType: "direct", proxyHost: "", proxyPort: "" }),
        "profile-0002",
      ),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.proxy.host).toBeUndefined();
    expect(parsed.value.proxy.port).toBeUndefined();
    expect(parsed.value.proxy.username).toBeUndefined();
  });

  it("converts manual identity fields and drops them in automatic mode", () => {
    const manual = parseProfile(
      toProfileInput(
        formValues({
          identityMode: "manual",
          latitude: "52.374",
          longitude: "4.88969",
          accuracy: "25000",
          timezone: "Europe/Amsterdam",
        }),
        "profile-0003",
      ),
    );
    expect(manual.ok).toBe(true);
    expect(manual.ok && manual.value.identity).toMatchObject({
      mode: "manual",
      latitude: 52.374,
      longitude: 4.88969,
      accuracy: 25000,
      timezone: "Europe/Amsterdam",
    });

    // Stale manual values in the form are ignored while automatic mode is selected.
    const automatic = parseProfile(
      toProfileInput(
        formValues({
          identityMode: "auto",
          latitude: "1",
          longitude: "2",
          accuracy: "5",
          timezone: "UTC",
        }),
        "profile-0004",
      ),
    );
    expect(automatic.ok && automatic.value.identity).toMatchObject({ mode: "auto" });
  });

  it("reports problems through the shared profile parser", () => {
    const parsed = parseProfile(toProfileInput(formValues({ proxyPort: "70000" }), "profile-0005"));
    expect(parsed.ok).toBe(false);

    const badTimezone = parseProfile(
      toProfileInput(
        formValues({
          identityMode: "manual",
          latitude: "1",
          longitude: "2",
          timezone: "Mars/Olympus",
        }),
        "profile-0006",
      ),
    );
    expect(badTimezone.ok).toBe(false);
  });
});

describe("credentialsIntentFrom", () => {
  it("keeps stored credentials when the password field is blank", () => {
    expect(credentialsIntentFrom(formValues({ password: "" }))).toEqual({ action: "keep" });
  });

  it("sets credentials when a password is typed", () => {
    expect(
      credentialsIntentFrom(formValues({ password: "hunter2", proxyUsername: "user" })),
    ).toEqual({
      action: "set",
      username: "user",
      password: "hunter2",
    });
  });

  it("clears credentials only when explicitly requested", () => {
    expect(credentialsIntentFrom(formValues({ password: "", removeCredentials: true }))).toEqual({
      action: "clear",
    });
  });
});

describe("toFormValues", () => {
  it("provides sensible defaults for a new profile", () => {
    const values = toFormValues(null);

    expect(values.id).toBeUndefined();
    expect(values.proxyType).toBe("http");
    expect(values.identityMode).toBe("auto");
    expect(parseBypassHostsInput(values.bypassHosts)).toEqual(["localhost", "127.0.0.1", "::1"]);
    expect(values.webrtcPolicy).toBe("automatic");
    expect(values.password).toBe("");
  });

  it("never loads a stored password into the form", () => {
    const values = toFormValues(makeProfile({ id: "profile-0007" }));
    expect(values.password).toBe("");
    expect(values.removeCredentials).toBe(false);
  });

  it("round-trips a manual profile", () => {
    const profile = makeProfile({
      id: "profile-0008",
      name: "Paris",
      identity: {
        mode: "manual",
        latitude: 48.8566,
        longitude: 2.3522,
        accuracy: 500,
        timezone: "Europe/Paris",
      },
      webrtcPolicy: "proxy_only",
    });

    const values = toFormValues(profile);
    const parsed = parseProfile(toProfileInput(values, profile.id));

    expect(parsed.ok).toBe(true);
    expect(parsed).toEqual(parseProfile(profile));
  });
});

describe("proxy field hints", () => {
  it("explains that SOCKS4 cannot authenticate", () => {
    expect(proxyFieldHints("socks4").join(" ")).toContain("does not support authentication");
    expect(isCredentialsSupported("socks4")).toBe(false);
    expect(isCredentialsSupported("socks5")).toBe(true);
  });

  it("explains how HTTP proxy credentials are sent", () => {
    const hints = proxyFieldHints("http").join(" ");
    expect(hints).toContain("preemptive");
    expect(hints).toContain("SOCKS");
  });

  it("mentions SOCKS authentication for SOCKS5", () => {
    expect(proxyFieldHints("socks5").join(" ")).toContain("SOCKS authentication");
  });
});

describe("persisted state expectations", () => {
  it("keeps the schema version stable for the stored state", () => {
    expect(SCHEMA_VERSION).toBe(2);
  });
});
