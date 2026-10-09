import { describe, expect, it } from "vitest";
import { DEFAULT_BYPASS_HOSTS } from "../src/shared/constants";
import { parseCredentials, parseProfile, parseProfileState } from "../src/profile/validation";
import { createProfile, SCHEMA_VERSION } from "../src/profile/schema";
import { makeProfile } from "./helpers";

describe("parseProfile", () => {
  it("rejects a malformed non-secret authentication marker", () => {
    const profile = makeProfile({ id: "session-user-profile" });
    expect(
      parseProfile({ ...profile, proxy: { ...profile.proxy, authenticationRequired: "yes" } }).ok,
    ).toBe(false);
  });
  it("accepts a valid HTTP proxy profile and drops unknown keys", () => {
    const parsed = parseProfile({
      ...makeProfile({ id: "profile-0001" }),
      password: "super-secret",
      proxy: {
        type: "http",
        host: "Proxy.Example.COM",
        port: 3128,
        username: "user",
        password: "super-secret",
        proxyDNS: false,
        bypassHosts: ["localhost"],
        unexpected: "ignored",
      },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.proxy.host).toBe("proxy.example.com");
    expect(parsed.value.proxy.port).toBe(3128);
    expect(parsed.value.proxy.authenticationRequired).toBe(true);
    expect(Object.keys(parsed.value.proxy)).not.toContain("username");
    // Neither the profile nor its proxy may carry a password, even when supplied.
    expect(JSON.stringify(parsed.value)).not.toContain("super-secret");
    expect(Object.keys(parsed.value.proxy)).not.toContain("password");
    expect(Object.keys(parsed.value)).not.toContain("password");
  });

  it("requires a host and port for proxied profiles", () => {
    const missingHost = parseProfile(
      makeProfile({
        id: "profile-0002",
        proxy: { type: "socks5", port: 1080, proxyDNS: true, bypassHosts: [] },
      }),
    );
    expect(missingHost.ok).toBe(false);
    expect(!missingHost.ok && missingHost.errors.join(" ")).toContain("host");

    const missingPort = parseProfile(
      makeProfile({
        id: "profile-0003",
        proxy: { type: "socks5", host: "127.0.0.1", proxyDNS: true, bypassHosts: [] },
      }),
    );
    expect(missingPort.ok).toBe(false);
    expect(!missingPort.ok && missingPort.errors.join(" ")).toContain("port");
  });

  it("rejects invalid proxy ports", () => {
    for (const port of [0, 65536, 8080.5, -1, Number.NaN, "8080"]) {
      const parsed = parseProfile(
        makeProfile({
          id: "profile-0004",
          proxy: {
            type: "http",
            host: "127.0.0.1",
            port: port as number,
            proxyDNS: false,
            bypassHosts: [],
          },
        }),
      );
      expect(parsed.ok, `port ${String(port)} must be rejected`).toBe(false);
    }
  });

  it("strips host and port from direct profiles", () => {
    const parsed = parseProfile({
      ...makeProfile({ id: "profile-0005" }),
      proxy: { type: "direct", host: "127.0.0.1", port: 8080, proxyDNS: true, bypassHosts: [] },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.proxy.host).toBeUndefined();
    expect(parsed.value.proxy.port).toBeUndefined();
  });

  it("defaults proxyDNS to true for SOCKS5 and false otherwise", () => {
    const socks5 = parseProfile({
      id: "profile-0006",
      name: "socks",
      proxy: { type: "socks5", host: "127.0.0.1", port: 1080 },
      identity: { mode: "auto" },
      webrtcPolicy: "disable_non_proxied_udp",
    });
    expect(socks5.ok && socks5.value.proxy.proxyDNS).toBe(true);

    const http = parseProfile({
      id: "profile-0007",
      name: "http",
      proxy: { type: "http", host: "127.0.0.1", port: 8080 },
      identity: { mode: "auto" },
      webrtcPolicy: "disable_non_proxied_udp",
    });
    expect(http.ok && http.value.proxy.proxyDNS).toBe(false);
  });

  it("applies the default bypass list when none is supplied", () => {
    const parsed = parseProfile({
      id: "profile-0008",
      name: "defaults",
      proxy: { type: "http", host: "127.0.0.1", port: 8080 },
      identity: { mode: "auto" },
      webrtcPolicy: "default",
    });
    expect(parsed.ok && parsed.value.proxy.bypassHosts).toEqual([...DEFAULT_BYPASS_HOSTS]);
  });

  it("requires coordinates, accuracy and timezone in manual mode", () => {
    const missing = parseProfile(makeProfile({ id: "profile-0009", identity: { mode: "manual" } }));
    expect(missing.ok).toBe(false);
    const errors = missing.ok ? [] : missing.errors.join(" ");
    expect(errors).toContain("latitude");
    expect(errors).toContain("longitude");
    expect(errors).toContain("accuracy");
    expect(errors).toContain("timezone");

    const valid = parseProfile(
      makeProfile({
        id: "profile-0010",
        identity: {
          mode: "manual",
          latitude: 52.374,
          longitude: 4.88969,
          accuracy: 1000,
          timezone: "Europe/Amsterdam",
        },
      }),
    );
    expect(valid.ok).toBe(true);
  });

  it("rejects invalid IANA timezones", () => {
    for (const timezone of ["Mars/Olympus", "GMT+2", "Not/AZone", "", "America/Not_A_Zone"]) {
      const parsed = parseProfile(
        makeProfile({
          id: "profile-0011",
          identity: { mode: "manual", latitude: 1, longitude: 2, accuracy: 100, timezone },
        }),
      );
      expect(parsed.ok, `timezone ${timezone} must be rejected`).toBe(false);
    }
  });

  it("accepts valid IANA timezones, including aliases and UTC", () => {
    for (const timezone of [
      "America/Los_Angeles",
      "Europe/Amsterdam",
      "Asia/Kolkata",
      "UTC",
      "US/Pacific",
    ]) {
      const parsed = parseProfile(
        makeProfile({
          id: "profile-0012",
          identity: { mode: "manual", latitude: 1, longitude: 2, accuracy: 100, timezone },
        }),
      );
      expect(parsed.ok, `timezone ${timezone} must be accepted`).toBe(true);
    }
  });

  it("rejects out-of-range coordinates and non-positive accuracy", () => {
    const latitude = parseProfile(
      makeProfile({
        id: "profile-0013",
        identity: { mode: "manual", latitude: 91, longitude: 2, accuracy: 100, timezone: "UTC" },
      }),
    );
    expect(latitude.ok).toBe(false);

    const longitude = parseProfile(
      makeProfile({
        id: "profile-0014",
        identity: { mode: "manual", latitude: 1, longitude: 181, accuracy: 100, timezone: "UTC" },
      }),
    );
    expect(longitude.ok).toBe(false);

    const accuracy = parseProfile(
      makeProfile({
        id: "profile-0015",
        identity: { mode: "manual", latitude: 1, longitude: 2, accuracy: 0, timezone: "UTC" },
      }),
    );
    expect(accuracy.ok).toBe(false);
  });

  it("rejects a partial position", () => {
    const parsed = parseProfile(
      makeProfile({ id: "profile-0016", identity: { mode: "auto", latitude: 10 } }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("validates identifiers, names, countries and WebRTC policies", () => {
    expect(parseProfile(makeProfile({ id: "short" })).ok).toBe(false);
    expect(parseProfile({ ...makeProfile({ id: "profile-0017" }), name: "   " }).ok).toBe(false);
    expect(
      parseProfile(
        makeProfile({ id: "profile-0018", identity: { mode: "auto", countryCode: "NLD" } }),
      ).ok,
    ).toBe(false);
    expect(
      parseProfile({
        ...makeProfile({ id: "profile-0019" }),
        webrtcPolicy: "disable_everything",
      }).ok,
    ).toBe(false);
  });

  it("upper-cases country codes and validates public IPs", () => {
    const parsed = parseProfile(
      makeProfile({
        id: "profile-0020",
        identity: { mode: "auto", countryCode: "nl", publicIp: "203.0.113.5" },
      }),
    );
    expect(parsed.ok && parsed.value.identity.countryCode).toBe("NL");
    expect(
      parseProfile(
        makeProfile({ id: "profile-0021", identity: { mode: "auto", publicIp: "not-an-ip" } }),
      ).ok,
    ).toBe(false);
  });
});

describe("parseProfileState", () => {
  it("rejects unknown schema versions", () => {
    expect(parseProfileState({ schemaVersion: 99, activeProfileId: null, profiles: [] }).ok).toBe(
      false,
    );
  });

  it("keeps valid profiles, drops invalid ones and de-duplicates ids", () => {
    const profile = makeProfile({ id: "profile-0030" });
    const parsed = parseProfileState({
      schemaVersion: SCHEMA_VERSION,
      activeProfileId: "profile-0030",
      appliedSelection: { kind: "profile", profile },
      profiles: [profile, { ...profile, name: "duplicate id" }, { id: "broken" }],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.profiles).toHaveLength(1);
    expect(parsed.value.activeProfileId).toBe("profile-0030");
  });

  it("clears an active pointer that does not resolve", () => {
    const parsed = parseProfileState({
      schemaVersion: SCHEMA_VERSION,
      activeProfileId: "profile-9999",
      appliedSelection: null,
      profiles: [makeProfile({ id: "profile-0031" })],
    });
    expect(parsed.ok && parsed.value.activeProfileId).toBeNull();
  });
});

describe("parseCredentials", () => {
  it("accepts a username, a password or both", () => {
    expect(parseCredentials({ username: "user", password: "pw" })).toEqual({
      ok: true,
      value: { username: "user", password: "pw" },
    });
    expect(parseCredentials({ password: "pw" })).toEqual({
      ok: true,
      value: { username: "", password: "pw" },
    });
  });

  it("rejects empty and malformed input", () => {
    expect(parseCredentials({}).ok).toBe(false);
    expect(parseCredentials({ username: "", password: "" }).ok).toBe(false);
    expect(parseCredentials({ username: 5 }).ok).toBe(false);
    expect(parseCredentials("user:pw").ok).toBe(false);
    expect(parseCredentials({ username: "u", password: "p".repeat(300) }).ok).toBe(false);
  });
});

describe("createProfile", () => {
  it("defaults new proxy profiles to strict WebRTC protection", () => {
    expect(createProfile("profile-0040", "proxy", "socks5").webrtcPolicy).toBe("proxy_only");
    expect(createProfile("profile-0041", "direct", "direct").webrtcPolicy).toBe("default");
    expect(createProfile("profile-0042", "socks5", "socks5").proxy.proxyDNS).toBe(true);
  });
});
