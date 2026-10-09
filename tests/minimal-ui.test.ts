import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { protectionKeys } from "../src/shared/protection-summary";
import { toFormValues } from "../src/options/form";
import { createProfile } from "../src/profile/schema";

describe("minimal interface and honest protection defaults", () => {
  it("defaults new profiles to DNS, strict WebRTC and automatic identity", () => {
    const defaults = toFormValues(null);
    expect(
      protectionKeys(
        defaults.proxyType,
        defaults.proxyDns,
        defaults.webrtcPolicy,
        defaults.identityMode === "auto",
      ),
    ).toEqual(["dnsOn", "webrtcOn", "identityOn"]);
  });
  it.each(["http", "https", "direct"])("does not claim a SOCKS DNS toggle for %s", (type) => {
    expect(protectionKeys(type, true, "proxy_only", true)[0]).toBe("dnsProtocol");
  });
  it("preserves existing user overrides and describes them honestly", () => {
    const profile = createProfile("custom-profile", "Custom", "socks5");
    profile.proxy.proxyDNS = false;
    profile.webrtcPolicy = "default";
    profile.webrtcMode = "manual";
    profile.identity = {
      mode: "manual",
      latitude: 1,
      longitude: 2,
      accuracy: 1000,
      timezone: "UTC",
    };
    const form = toFormValues(profile);
    expect(
      protectionKeys(
        form.proxyType,
        form.proxyDns,
        form.webrtcPolicy,
        form.identityMode === "auto",
      ),
    ).toEqual(["dnsOff", "webrtcCustom", "identityCustom"]);
  });
  it("moves long privacy and compatibility prose behind a closed disclosure", () => {
    const html = readFileSync("src/options/options.html", "utf8");
    expect(html).toContain('<details class="footer-disclosure" id="privacy-info">');
    const privacy = html.slice(html.indexOf('id="privacy-info"'), html.indexOf('id="guide"'));
    expect(privacy).toContain('data-i18n="collectionNotice"');
    expect(privacy).toContain('data-i18n="shimLimitNotice"');
    expect(privacy).toContain('data-i18n="draftDisclosure"');
    expect(html).toContain('data-i18n="draftShortDisclosure"');
    expect(html.indexOf('id="guide"')).toBeGreaterThan(html.indexOf("</main>"));
  });
  it("keeps authentication, custom settings and required controls accessible", () => {
    const options = readFileSync("src/options/options.html", "utf8");
    const popup = readFileSync("src/popup/popup.html", "utf8");
    expect(options).toContain('<details class="editor-section-collapsible" id="section-auth">');
    for (const id of [
      "field-proxy-dns",
      "field-webrtc",
      "field-mode-manual",
      "field-geoip-policy",
      "field-timezone",
      "save-activate",
    ])
      expect(options).toContain(`id="${id}"`);
    expect(popup).toContain('id="quick-customization"');
    expect(popup).toContain('id="quick-protection-summary"');
  });
});
