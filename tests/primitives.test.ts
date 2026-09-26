import { describe, expect, it } from "vitest";
import {
  bypassEntryMatchesHost,
  isIpAddress,
  isIpv4InCidr,
  isValidBypassEntry,
  isValidHost,
  isValidPort,
  normalizeHost,
  parseBypassHosts,
  parseIdentityMode,
  parseProxyType,
  parseWebRtcPolicy,
  shouldBypassHost,
} from "../src/shared/primitives";

describe("isValidHost", () => {
  it("accepts hostnames, IPv4 and IPv6 literals", () => {
    expect(isValidHost("example.com")).toBe(true);
    expect(isValidHost("proxy.internal.example.com")).toBe(true);
    expect(isValidHost("localhost")).toBe(true);
    expect(isValidHost("127.0.0.1")).toBe(true);
    expect(isValidHost("::1")).toBe(true);
    expect(isValidHost("[::1]")).toBe(true);
    expect(isValidHost("2001:db8::1")).toBe(true);
    expect(isValidHost("::ffff:192.0.2.1")).toBe(true);
  });

  it("rejects values that are not bare hosts", () => {
    for (const value of [
      "",
      " ",
      "http://example.com",
      "example.com:8080",
      "-bad.example.com",
      "exa mple.com",
      "01.2.3.4",
      ":::",
      "[::1",
      "a".repeat(300),
    ]) {
      expect(isValidHost(value), `expected ${JSON.stringify(value)} to be rejected`).toBe(false);
    }
  });
});

describe("isIpAddress", () => {
  it("distinguishes IP literals from hostnames", () => {
    expect(isIpAddress("192.0.2.1")).toBe(true);
    expect(isIpAddress("2001:db8::1")).toBe(true);
    expect(isIpAddress("example.com")).toBe(false);
    expect(isIpAddress("999.1.1.1")).toBe(false);
  });
});

describe("isValidPort", () => {
  it("accepts only integers in the TCP range", () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(8080)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
  });

  it("rejects out-of-range and non-integer ports", () => {
    for (const value of [
      0,
      65536,
      -1,
      80.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "80",
      null,
      undefined,
    ]) {
      expect(isValidPort(value), `expected ${String(value)} to be rejected`).toBe(false);
    }
  });
});

describe("normalizeHost", () => {
  it("lower-cases, unwraps brackets and strips a trailing dot", () => {
    expect(normalizeHost("[::1]")).toBe("::1");
    expect(normalizeHost("EXAMPLE.com.")).toBe("example.com");
    expect(normalizeHost("  Example.COM ")).toBe("example.com");
  });
});

describe("bypass matching", () => {
  it("matches a bare host and its subdomains", () => {
    expect(bypassEntryMatchesHost("example.com", "example.com")).toBe(true);
    expect(bypassEntryMatchesHost("example.com", "www.example.com")).toBe(true);
    expect(bypassEntryMatchesHost("example.com", "notexample.com")).toBe(false);
  });

  it("matches localhost and its subdomains", () => {
    expect(bypassEntryMatchesHost("localhost", "localhost")).toBe(true);
    expect(bypassEntryMatchesHost("localhost", "app.localhost")).toBe(true);
    expect(bypassEntryMatchesHost("localhost", "localhost.example.com")).toBe(false);
  });

  it("supports wildcard entries without matching sibling names", () => {
    expect(bypassEntryMatchesHost("*.example.com", "a.example.com")).toBe(true);
    expect(bypassEntryMatchesHost("*.example.com", "example.com")).toBe(true);
    expect(bypassEntryMatchesHost("*.example.com", "aexample.com")).toBe(false);
  });

  it("matches IP literals exactly and CIDR ranges by prefix", () => {
    expect(bypassEntryMatchesHost("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(bypassEntryMatchesHost("127.0.0.1", "127.0.0.2")).toBe(false);
    expect(bypassEntryMatchesHost("::1", "::1")).toBe(true);
    expect(bypassEntryMatchesHost("10.0.0.0/8", "10.1.2.3")).toBe(true);
    expect(bypassEntryMatchesHost("10.0.0.0/8", "11.1.2.3")).toBe(false);
    expect(bypassEntryMatchesHost("192.168.0.0/16", "192.168.55.4")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(bypassEntryMatchesHost("Example.COM", "WWW.example.com")).toBe(true);
  });

  it("checks a list", () => {
    expect(shouldBypassHost("localhost", ["localhost", "127.0.0.1", "::1"])).toBe(true);
    expect(shouldBypassHost("example.com", ["localhost", "127.0.0.1", "::1"])).toBe(false);
  });

  it("computes CIDR containment for /0 and /32", () => {
    expect(isIpv4InCidr("203.0.113.9", "0.0.0.0/0")).toBe(true);
    expect(isIpv4InCidr("203.0.113.9", "203.0.113.9/32")).toBe(true);
    expect(isIpv4InCidr("203.0.113.10", "203.0.113.9/32")).toBe(false);
  });
});

describe("isValidBypassEntry", () => {
  it("accepts the documented forms", () => {
    for (const value of [
      "localhost",
      "example.com",
      "*.example.com",
      "127.0.0.1",
      "::1",
      "10.0.0.0/8",
    ]) {
      expect(isValidBypassEntry(value), value).toBe(true);
    }
  });

  it("rejects malformed entries, including IPv6 CIDR which is unsupported", () => {
    for (const value of [
      "",
      "*.",
      "http://example.com",
      "10.0.0.0/33",
      "10.0.0.0/x",
      "2001:db8::/32",
      42,
    ]) {
      expect(isValidBypassEntry(value), String(value)).toBe(false);
    }
  });
});

describe("parseBypassHosts", () => {
  it("defaults to an empty list when undefined", () => {
    const parsed = parseBypassHosts(undefined, 10);
    expect(parsed.ok && parsed.value).toEqual([]);
  });

  it("normalises and de-duplicates entries", () => {
    const parsed = parseBypassHosts(["LOCALHOST", "localhost", " Example.com "], 10);
    expect(parsed.ok && parsed.value).toEqual(["localhost", "example.com"]);
  });

  it("reports errors for invalid input", () => {
    expect(parseBypassHosts("localhost", 10).ok).toBe(false);
    expect(parseBypassHosts(["ok.example.com", "bad host"], 10).ok).toBe(false);
    expect(
      parseBypassHosts(
        Array.from({ length: 5 }, (_, index) => `h${index}.example.com`),
        3,
      ).ok,
    ).toBe(false);
  });
});

describe("enum parsers", () => {
  it("parses proxy types", () => {
    expect(parseProxyType("socks5")).toEqual({ ok: true, value: "socks5" });
    expect(parseProxyType("ftp").ok).toBe(false);
    expect(parseProxyType(undefined).ok).toBe(false);
  });

  it("parses WebRTC policies, including proxy_only", () => {
    expect(parseWebRtcPolicy("proxy_only")).toEqual({ ok: true, value: "proxy_only" });
    expect(parseWebRtcPolicy("disable_non_proxied_udp")).toEqual({
      ok: true,
      value: "disable_non_proxied_udp",
    });
    expect(parseWebRtcPolicy("nope").ok).toBe(false);
  });

  it("parses identity modes", () => {
    expect(parseIdentityMode("manual")).toEqual({ ok: true, value: "manual" });
    expect(parseIdentityMode("sometimes").ok).toBe(false);
  });
});
