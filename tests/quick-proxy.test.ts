import { describe, expect, it } from "vitest";
import { parseQuickEndpoint, quickProxyProfile } from "../src/profile/quick-proxy";
import { MAX_PROFILES } from "../src/shared/constants";

describe("local quick proxy parsing", () => {
  it.each([
    ["127.0.0.1:10808", "socks5", "127.0.0.1", 10808],
    ["localhost:10809", "socks5", "localhost", 10809],
    ["proxy.example.com:8080", "socks5", "proxy.example.com", 8080],
    ["socks5://127.0.0.1:10808", "socks5", "127.0.0.1", 10808],
    ["HTTP://PROXY.EXAMPLE.COM:8080", "http", "proxy.example.com", 8080],
    ["https://proxy.example.com:443", "https", "proxy.example.com", 443],
    ["socks5://[2001:db8::1]:1080", "socks5", "2001:db8::1", 1080],
    ["socks4://[::1]:1", "socks4", "::1", 1],
  ])("parses %s without protocol probing", (input, type, host, port) => {
    expect(parseQuickEndpoint(input, "", "socks5")).toEqual({
      ok: true,
      value: { type, host, port },
    });
  });
  it("supports separate fields and explicit inline port precedence", () => {
    expect(parseQuickEndpoint("localhost", "65535", "https")).toMatchObject({
      ok: true,
      value: { type: "https", port: 65535 },
    });
    expect(parseQuickEndpoint("[::1]", "1080", "socks5")).toMatchObject({ ok: true });
    expect(parseQuickEndpoint("localhost:443", "8080", "http")).toMatchObject({
      ok: true,
      value: { port: 443 },
    });
  });
  it.each([
    "",
    "host:0",
    "host:65536",
    "host:-1",
    "host:1.2",
    "host:1e3",
    "host:",
    "host: 80",
    "host:80/path",
    "http://host:80/",
    "host:80?x",
    "host:80#x",
    "host\\evil:80",
    "::1:80",
    "[::1",
    "[::1]x:80",
    "999.1.1.1:80",
    "ftp://host:80",
    "http://host%zz:80",
    "host\nname:80",
    "x".repeat(1025),
  ])("rejects invalid endpoint %s", (input) => {
    expect(parseQuickEndpoint(input, "", "socks5").ok).toBe(false);
  });
  it("rejects pasted credentials without reflecting them", () => {
    const result = parseQuickEndpoint("http://synthetic-secret:password@host:80", "", "http");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(JSON.stringify(result)).not.toContain("password@");
  });
  it("constructs validated profiles, allocates names, permits deliberate endpoint duplicates", () => {
    const endpoint = { type: "socks5" as const, host: "localhost", port: 1080 };
    const first = quickProxyProfile(endpoint, "", "profile-0001", []);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = quickProxyProfile(endpoint, "", "profile-0002", [first.value]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.name).not.toBe(first.value.name);
    expect(quickProxyProfile(endpoint, first.value.name, "profile-0003", [first.value]).ok).toBe(
      false,
    );
    expect(
      quickProxyProfile(
        endpoint,
        "",
        "profile-0003",
        Array.from({ length: MAX_PROFILES }, () => first.value),
      ).ok,
    ).toBe(false);
    expect(JSON.stringify(second.value)).not.toMatch(/password|username/);
  });
});
