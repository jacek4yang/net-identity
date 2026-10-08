import { describe, expect, it } from "vitest";
import en from "../public/_locales/en/messages.json";
import zh from "../public/_locales/zh_CN/messages.json";
import {
  message,
  parseLanguage,
  resolveLocale,
  localizeKnownText,
  setUiLocale,
} from "../src/shared/i18n";
import { readFileSync } from "node:fs";

describe("single-source Firefox locale catalogs", () => {
  it("has identical nonempty keys with matching placeholder tokens", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(en[key].message.trim()).not.toBe("");
      expect(zh[key].message.trim()).not.toBe("");
      expect(zh[key].message.match(/\$[A-Za-z0-9_]+\$/g) ?? []).toEqual(
        en[key].message.match(/\$[A-Za-z0-9_]+\$/g) ?? [],
      );
    }
  });
  it.each([
    ["en-US", "en"],
    ["zh-CN", "zh_CN"],
    ["zh-Hans", "zh_CN"],
    ["zh-Hans-CN", "zh_CN"],
    ["zh-SG", "zh_CN"],
    ["zh-TW", "en"],
    ["de", "en"],
  ])("resolves automatic locale %s", (language, expected) => {
    expect(resolveLocale("auto", language)).toBe(expected);
  });
  it("honors manual choices regardless of browser locale", () => {
    expect(resolveLocale("en", "zh-CN")).toBe("en");
    expect(resolveLocale("zh_CN", "en-US")).toBe("zh_CN");
    expect(parseLanguage({})).toBe("auto");
    expect(parseLanguage("unknown")).toBe("auto");
  });
  it("changes UI strings without interpreting arbitrary values", () => {
    setUiLocale("zh_CN");
    expect(message("save")).toBe("保存");
    expect(localizeKnownText("Saving profile…")).toBe("正在保存配置…");
    expect(localizeKnownText("<img src=x onerror=evil()>")).toBe("<img src=x onerror=evil()>");
    expect(localizeKnownText("Asia/Tokyo")).toBe("Asia/Tokyo");
    setUiLocale("en");
    expect(message("save")).toBe("Save");
  });
  it("references only existing static UI keys and packages both locales", () => {
    const html = readFileSync(new URL("../src/popup/popup.html", import.meta.url), "utf8");
    for (const match of html.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g))
      expect(Object.hasOwn(en, match[1] ?? "")).toBe(true);
    const build = readFileSync(new URL("../scripts/build.mjs", import.meta.url), "utf8");
    expect(build).toContain('path.join(dist, "_locales")');
    const control = readFileSync(
      new URL("../src/shared/language-control.ts", import.meta.url),
      "utf8",
    );
    expect(control).not.toMatch(/profiles:|identity:refresh|proxy\.settings|sendMessage/);
  });
});
