import { describe, expect, it } from "vitest";
import {
  buildProxyInfo,
  credentialsSupported,
  decideProxy,
  createAuthAttemptTracker,
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
  it("accepts http(s) and ws(s) hosts", () => {
    expect(parseRequestUrl("https://Example.com/path")).toEqual({
      scheme: "https",
      hostname: "example.com",
    });
    expect(parseRequestUrl("http://127.0.0.1:8080/")).toEqual({
      scheme: "http",
      hostname: "127.0.0.1",
    });
    expect(parseRequestUrl("wss://Example.com/socket")).toEqual({
      scheme: "wss",
      hostname: "example.com",
    });
    expect(parseRequestUrl("ws://example.com:9/socket")).toEqual({
      scheme: "ws",
      hostname: "example.com",
    });
    expect(parseRequestUrl("WS://Example.COM/socket")).toEqual({
      scheme: "ws",
      hostname: "example.com",
    });
    expect(parseRequestUrl("wss://user:secret@example.com/socket")).toEqual({
      scheme: "wss",
      hostname: "example.com",
    });
    expect(parseRequestUrl("ws://[::1]/socket")).toEqual({
      scheme: "ws",
      hostname: "::1",
    });
  });

  it("rejects non-network and unparsable URLs", () => {
    expect(parseRequestUrl("moz-extension://abc/background.js")).toBeNull();
    expect(parseRequestUrl("about:blank")).toBeNull();
    expect(parseRequestUrl("file:///tmp/page.html")).toBeNull();
    expect(parseRequestUrl("data:text/html,hi")).toBeNull();
    expect(
      parseRequestUrl("blob:https://example.com/11111111-1111-1111-1111-111111111111"),
    ).toBeNull();
    expect(parseRequestUrl("ftp://example.com/file")).toBeNull();
    expect(parseRequestUrl("not a url")).toBeNull();
    expect(parseRequestUrl("ws://")).toBeNull();
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

  it("routes WebSocket traffic through the same proxy and bypass rules", () => {
    const active = target({ bypassHosts: ["example.org", "10.0.0.0/8"] });
    const routed = decideProxy(active, "wss://example.com/socket");
    expect(routed.type).toBe("http");
    expect(routed.host).toBe("proxy.example.com");
    expect(decideProxy(active, "ws://example.com/socket").type).toBe("http");

    expect(decideProxy(active, "ws://localhost/socket")).toEqual({ type: "direct" });
    expect(decideProxy(active, "wss://127.0.0.1/socket")).toEqual({ type: "direct" });
    expect(decideProxy(active, "ws://[::1]/socket")).toEqual({ type: "direct" });
    expect(decideProxy(active, "wss://www.example.org/socket")).toEqual({ type: "direct" });
    expect(decideProxy(active, "ws://10.20.30.40/socket")).toEqual({ type: "direct" });
    expect(decideProxy(active, "wss://ipwho.is/")).toMatchObject({
      type: "http",
      host: "proxy.example.com",
    });
  });

  it("leaves non-network schemes direct even while a proxy is active", () => {
    const active = target({});
    expect(decideProxy(active, "ftp://example.com/file")).toEqual({ type: "direct" });
    expect(decideProxy(active, "file:///tmp/page.html")).toEqual({ type: "direct" });
    expect(decideProxy(active, "moz-extension://abc/background.js")).toEqual({ type: "direct" });
    expect(decideProxy(active, "about:blank")).toEqual({ type: "direct" });
    expect(decideProxy(active, "data:text/html,hi")).toEqual({ type: "direct" });
    expect(decideProxy(null, "wss://example.com/socket")).toEqual({ type: "direct" });
    expect(
      decideProxy(
        target({ type: "direct", host: undefined, port: undefined, bypassHosts: [] }),
        "wss://example.com/socket",
      ),
    ).toEqual({ type: "direct" });
  });
});

describe("decideProxyAuth", () => {
  const credentials: ProxyCredentials = { username: "user", password: "pw" };

  it("answers only when both challenger host and port match", () => {
    const active = target({}, credentials);
    expect(
      decideProxyAuth(active, {
        isProxy: true,
        challengerHost: "PROXY.example.com",
        challengerPort: 8080,
      }),
    ).toEqual(credentials);
    expect(
      decideProxyAuth(active, {
        isProxy: true,
        challengerHost: "proxy.example.com.",
        challengerPort: 8080,
      }),
    ).toEqual(credentials);
  });

  it("fails closed when the host matches but the port does not, or the port matches another host", () => {
    const active = target({}, credentials);
    expect(
      decideProxyAuth(active, {
        isProxy: true,
        challengerHost: "proxy.example.com",
        challengerPort: 1,
      }),
    ).toBeNull();
    expect(
      decideProxyAuth(active, { isProxy: true, challengerHost: "10.0.0.9", challengerPort: 8080 }),
    ).toBeNull();
    expect(
      decideProxyAuth(active, { isProxy: true, challengerHost: "proxy.example.com" }),
    ).toBeNull();
    expect(decideProxyAuth(active, { isProxy: true, challengerPort: 8080 })).toBeNull();
  });

  it("never answers origin authentication challenges", () => {
    const active = target({}, credentials);
    expect(
      decideProxyAuth(active, { isProxy: false, challengerHost: "proxy.example.com" }),
    ).toBeNull();
  });

  it("refuses when the challenger does not match the active proxy", () => {
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

describe("createAuthAttemptTracker", () => {
  it("answers a request id once and again only after release", () => {
    const tracker = createAuthAttemptTracker();
    expect(tracker.claim("req-1")).toBe(true);
    expect(tracker.claim("req-1")).toBe(false);
    expect(tracker.claim("")).toBe(false);
    tracker.release("req-1");
    expect(tracker.claim("req-1")).toBe(true);
  });

  it("forgets the oldest id after the cap so the map stays bounded", () => {
    const tracker = createAuthAttemptTracker(2);
    expect(tracker.claim("a")).toBe(true);
    expect(tracker.claim("b")).toBe(true);
    expect(tracker.claim("c")).toBe(true);
    expect(tracker.claim("a")).toBe(true);
    expect(tracker.claim("c")).toBe(false);
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
