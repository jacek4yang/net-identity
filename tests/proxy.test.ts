import { describe, expect, it } from "vitest";
import {
  buildProxyInfo,
  credentialsSupported,
  decideProxy,
  decideProxyAuth,
  encodeBasicAuthorization,
  parseRequestUrl,
  readFirefoxProxySettings,
  type ActiveProxyTarget,
} from "../src/background/proxy";
import type { ProxyConfig } from "../src/profile/schema";
import type { ProxyCredentials } from "../src/profile/validation";

function target(
  proxy: Partial<ProxyConfig>,
  credentials: ProxyCredentials | null = null,
): ActiveProxyTarget {
  return {
    profileId: "profile-0001",
    profileName: "test",
    generation: 1,
    proxy: {
      type: "http",
      host: "proxy.example.com",
      port: 8080,
      proxyDNS: false,
      bypassHosts: ["localhost", "127.0.0.1", "::1"],
      ...proxy,
    },
    credentials,
  };
}

describe("buildProxyInfo", () => {
  it("maps a direct profile", () => {
    expect(buildProxyInfo({ type: "direct", proxyDNS: false, bypassHosts: [] }, null)).toEqual({
      type: "direct",
    });
  });

  it("maps HTTP and HTTPS proxies without attaching credentials implicitly", () => {
    const http = buildProxyInfo(
      { type: "http", host: "proxy.example.com", port: 3128, proxyDNS: false, bypassHosts: [] },
      null,
    );
    expect(http).toEqual({ type: "http", host: "proxy.example.com", port: 3128 });

    const https = buildProxyInfo(
      { type: "https", host: "proxy.example.com", port: 3129, proxyDNS: false, bypassHosts: [] },
      null,
    );
    expect(https).toEqual({ type: "https", host: "proxy.example.com", port: 3129 });
  });

  it("adds a preemptive Basic authorization header for HTTP proxies with credentials", () => {
    const info = buildProxyInfo(
      { type: "http", host: "proxy.example.com", port: 3128, proxyDNS: false, bypassHosts: [] },
      { username: "user", password: "pw" },
    );
    expect(info.proxyAuthorizationHeader).toBe(encodeBasicAuthorization("user", "pw"));
    // Firefox does not accept username/password for HTTP proxies.
    expect(info.username).toBeUndefined();
    expect(info.password).toBeUndefined();
  });

  it("maps SOCKS5 to Firefox's 'socks' type and forwards credentials and proxyDNS", () => {
    const info = buildProxyInfo(
      { type: "socks5", host: "127.0.0.1", port: 1080, proxyDNS: true, bypassHosts: [] },
      { username: "user", password: "pw" },
    );
    expect(info).toEqual({
      type: "socks",
      host: "127.0.0.1",
      port: 1080,
      proxyDNS: true,
      username: "user",
      password: "pw",
    });
  });

  it("honours an explicitly disabled proxyDNS on SOCKS5", () => {
    const info = buildProxyInfo(
      { type: "socks5", host: "127.0.0.1", port: 1080, proxyDNS: false, bypassHosts: [] },
      null,
    );
    expect(info.proxyDNS).toBe(false);
  });

  it("never attaches credentials to SOCKS4, which Firefox cannot authenticate", () => {
    const info = buildProxyInfo(
      { type: "socks4", host: "127.0.0.1", port: 1080, proxyDNS: true, bypassHosts: [] },
      { username: "user", password: "pw" },
    );
    expect(info).toEqual({ type: "socks4", host: "127.0.0.1", port: 1080, proxyDNS: true });
    expect(credentialsSupported("socks4")).toBe(false);
  });
});

describe("encodeBasicAuthorization", () => {
  it("encodes ASCII credentials", () => {
    expect(encodeBasicAuthorization("user", "pw")).toBe("Basic dXNlcjpwdw==");
  });

  it("encodes non-ASCII credentials as UTF-8 instead of throwing", () => {
    const encoded = encodeBasicAuthorization("üser", "pässwörd");
    const base64 = encoded.replace("Basic ", "");
    expect(() => atob(base64)).not.toThrow();
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe("üser:pässwörd");
  });
});

describe("parseRequestUrl", () => {
  it("keeps only http(s) hosts", () => {
    expect(parseRequestUrl("https://Example.com/path")).toEqual({
      scheme: "https",
      hostname: "example.com",
    });
    expect(parseRequestUrl("http://127.0.0.1:8080/")).toEqual({
      scheme: "http",
      hostname: "127.0.0.1",
    });
    expect(parseRequestUrl("moz-extension://abc/background.js")).toBeNull();
    expect(parseRequestUrl("about:blank")).toBeNull();
    expect(parseRequestUrl("not a url")).toBeNull();
  });
});

describe("decideProxy", () => {
  it("is direct when nothing is active", () => {
    expect(decideProxy(null, "https://example.com/")).toEqual({ type: "direct" });
  });

  it("routes ordinary requests through the active proxy", () => {
    const decision = decideProxy(target({}), "https://example.com/");
    expect(decision.type).toBe("http");
    expect(decision.host).toBe("proxy.example.com");
  });

  it("bypasses loopback and configured hosts", () => {
    const active = target({ bypassHosts: ["example.org", "10.0.0.0/8"] });
    expect(decideProxy(active, "http://localhost:3000/")).toEqual({ type: "direct" });
    expect(decideProxy(active, "http://127.0.0.1/")).toEqual({ type: "direct" });
    expect(decideProxy(active, "https://www.example.org/")).toEqual({ type: "direct" });
    expect(decideProxy(active, "http://10.20.30.40/")).toEqual({ type: "direct" });
    expect(decideProxy(active, "https://example.com/").type).toBe("http");
  });

  it("does not bypass the GeoIP endpoint", () => {
    const decision = decideProxy(target({}), "https://ipwho.is/?fields=ip");
    expect(decision.type).toBe("http");
  });

  it("leaves non-http requests alone", () => {
    expect(decideProxy(target({}), "ws://example.com/socket")).toEqual({ type: "direct" });
  });
});

describe("decideProxyAuth", () => {
  const credentials: ProxyCredentials = { username: "user", password: "pw" };

  it("answers a challenge from the configured proxy", () => {
    const active = target({}, credentials);
    expect(decideProxyAuth(active, { isProxy: true, challengerHost: "proxy.example.com" })).toEqual(
      credentials,
    );
    expect(
      decideProxyAuth(active, {
        isProxy: true,
        challengerHost: "PROXY.example.com",
        challengerPort: 8080,
      }),
    ).toEqual(credentials);
  });

  it("matches on the configured port when the challenger host differs", () => {
    const active = target({}, credentials);
    expect(
      decideProxyAuth(active, { isProxy: true, challengerHost: "10.0.0.9", challengerPort: 8080 }),
    ).toEqual(credentials);
  });

  it("never answers origin authentication challenges", () => {
    const active = target({}, credentials);
    expect(
      decideProxyAuth(active, { isProxy: false, challengerHost: "proxy.example.com" }),
    ).toBeNull();
  });

  it("refuses when neither host nor port matches the active proxy", () => {
    const active = target({}, credentials);
    expect(
      decideProxyAuth(active, {
        isProxy: true,
        challengerHost: "evil.example.net",
        challengerPort: 443,
      }),
    ).toBeNull();
    expect(decideProxyAuth(active, { isProxy: true })).toBeNull();
  });

  it("refuses when there is no active target, no credentials, or a non-HTTP proxy", () => {
    expect(
      decideProxyAuth(null, { isProxy: true, challengerHost: "proxy.example.com" }),
    ).toBeNull();
    expect(
      decideProxyAuth(target({}, null), { isProxy: true, challengerHost: "proxy.example.com" }),
    ).toBeNull();
    expect(
      decideProxyAuth(target({ type: "socks5", port: 1080 }, credentials), {
        isProxy: true,
        challengerHost: "proxy.example.com",
        challengerPort: 1080,
      }),
    ).toBeNull();
  });
});

describe("readFirefoxProxySettings", () => {
  it("reports the configured proxy type and control level", async () => {
    const snapshot = await readFirefoxProxySettings({
      get: async () => ({
        value: { proxyType: "manual" },
        levelOfControl: "controllable_by_this_extension",
      }),
    });
    expect(snapshot).toEqual({
      proxyType: "manual",
      levelOfControl: "controllable_by_this_extension",
    });
  });

  it("reports unknown values instead of throwing", async () => {
    const snapshot = await readFirefoxProxySettings({
      get: async () => {
        throw new Error("not available");
      },
    });
    expect(snapshot).toEqual({ proxyType: "unknown", levelOfControl: "unknown" });

    const malformed = await readFirefoxProxySettings({
      get: async () => ({ value: 7, levelOfControl: "" }),
    });
    expect(malformed).toEqual({ proxyType: "unknown", levelOfControl: "unknown" });
  });
});
