import { afterEach, describe, expect, it } from "vitest";
import { localizedProxySummary } from "../src/shared/proxy-summary";
import { message, setUiLocale } from "../src/shared/i18n";
import type { ProxyConfig } from "../src/profile/schema";

const proxy: ProxyConfig = {
  type: "socks5",
  host: "fixture.example",
  port: 1080,
  proxyDNS: true,
  bypassHosts: [],
  authenticationRequired: true,
};

afterEach(() => setUiLocale("en"));

describe("localized proxy summary", () => {
  it("translates authentication without modifying the endpoint or profile", () => {
    setUiLocale("zh_CN");
    expect(localizedProxySummary(proxy)).toBe("SOCKS5 fixture.example:1080 · 需要认证");
    expect(proxy.authenticationRequired).toBe(true);
    setUiLocale("en");
    expect(localizedProxySummary(proxy)).toBe("SOCKS5 fixture.example:1080 with authentication");
  });
  it("does not invent authentication for an anonymous endpoint", () => {
    setUiLocale("zh_CN");
    expect(localizedProxySummary({ ...proxy, authenticationRequired: false })).toBe(
      "SOCKS5 fixture.example:1080",
    );
  });
  it("uses the current action label in credential removal instructions", () => {
    for (const locale of ["en", "zh_CN"] as const) {
      setUiLocale(locale);
      expect(message("clearCredentials")).toContain(message("enableDraft"));
    }
  });
});
