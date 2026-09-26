/**
 * These tests exercise the real MAIN-world timezone shim against Node's own Date and
 * Intl, which implement the same ECMAScript and timezone semantics as Firefox. That
 * makes it possible to assert the actual patch behaviour (including DST) without a
 * browser, while the shim itself stays free of Node-specific code.
 */
import { afterEach, describe, expect, it } from "vitest";
import { installTimeZoneShim, type TimeZoneShim } from "../src/content/timezone-shim";

let shim: TimeZoneShim | null = null;

function install(): TimeZoneShim {
  shim = installTimeZoneShim({ date: Date, intl: Intl });
  return shim;
}

afterEach(() => {
  shim?.uninstall();
  shim = null;
});

const WINTER = new Date(Date.UTC(2024, 0, 1, 12, 0, 0));
const SUMMER = new Date(Date.UTC(2024, 6, 1, 12, 0, 0));

describe("timezone shim", () => {
  it("leaves native behaviour untouched until a timezone is applied", () => {
    const nativeOffset = WINTER.getTimezoneOffset();
    const nativeString = WINTER.toString();
    const nativeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const installed = install();
    expect(installed.installed).toBe(true);
    expect(installed.getTimeZone()).toBeNull();
    expect(WINTER.getTimezoneOffset()).toBe(nativeOffset);
    expect(WINTER.toString()).toBe(nativeString);
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(nativeZone);
  });

  it("overrides getTimezoneOffset for the applied zone", () => {
    const installed = install();
    installed.setTimeZone("America/Los_Angeles");

    expect(WINTER.getTimezoneOffset()).toBe(480);
    expect(SUMMER.getTimezoneOffset()).toBe(420);

    installed.setTimeZone("UTC");
    expect(WINTER.getTimezoneOffset()).toBe(0);
  });

  it("overrides toString, toTimeString and toDateString", () => {
    const installed = install();
    installed.setTimeZone("America/Los_Angeles");

    expect(WINTER.toString()).toMatch(/^Mon Jan 01 2024 04:00:00 GMT-0800 \(Pacific .*Time\)$/);
    expect(WINTER.toTimeString()).toMatch(/^04:00:00 GMT-0800 \(Pacific .*Time\)$/);
    expect(WINTER.toDateString()).toBe("Mon Jan 01 2024");
    expect(new Date(Number.NaN).toString()).toBe("Invalid Date");
  });

  it("applies the zone to Intl.DateTimeFormat unless the caller asked for another", () => {
    const installed = install();
    installed.setTimeZone("America/Los_Angeles");

    expect(new Intl.DateTimeFormat("en-US").resolvedOptions().timeZone).toBe("America/Los_Angeles");
    expect(Intl.DateTimeFormat("en-US").resolvedOptions().timeZone).toBe("America/Los_Angeles");
    expect(new Intl.DateTimeFormat("en-US", {}).resolvedOptions().timeZone).toBe(
      "America/Los_Angeles",
    );
    expect(new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).resolvedOptions().timeZone).toBe(
      "UTC",
    );
    expect(
      new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris" }).resolvedOptions().timeZone,
    ).toBe("Europe/Paris");
  });

  it("keeps Intl.DateTimeFormat usable as a constructor and as a namespace", () => {
    const installed = install();
    installed.setTimeZone("America/Los_Angeles");

    const formatter = new Intl.DateTimeFormat("en-US");
    expect(formatter).toBeInstanceOf(Intl.DateTimeFormat);
    expect(typeof Intl.DateTimeFormat.supportedLocalesOf).toBe("function");
    expect(Intl.DateTimeFormat.supportedLocalesOf(["en-US"])).toContain("en-US");
  });

  it("applies the zone to toLocaleString and friends, preserving explicit requests", () => {
    const installed = install();
    installed.setTimeZone("America/Los_Angeles");

    const timeOptions: Intl.DateTimeFormatOptions = {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    };
    expect(WINTER.toLocaleTimeString("en-US", timeOptions)).toBe("04:00");
    expect(WINTER.toLocaleTimeString("en-US", { ...timeOptions, timeZone: "UTC" })).toBe("12:00");
    expect(WINTER.toLocaleString("en-US", timeOptions)).toContain("04:00");
    expect(WINTER.toLocaleDateString("en-US", { timeZone: "UTC", day: "2-digit" })).toBe("01");
  });

  it("tolerates unusual options without throwing", () => {
    const installed = install();
    installed.setTimeZone("UTC");
    expect(typeof WINTER.toLocaleString()).toBe("string");
    expect(typeof WINTER.toLocaleDateString("en-US")).toBe("string");
    expect(typeof WINTER.toLocaleTimeString("en-US")).toBe("string");
  });

  it("rejects invalid timezones instead of applying them", () => {
    const installed = install();
    installed.setTimeZone("America/Los_Angeles");
    expect(installed.getTimeZone()).toBe("America/Los_Angeles");

    installed.setTimeZone("Mars/Olympus");
    expect(installed.getTimeZone()).toBeNull();

    installed.setTimeZone("America/Los_Angeles");
    installed.setTimeZone(null);
    expect(installed.getTimeZone()).toBeNull();
    expect(WINTER.getTimezoneOffset()).toBe(new Date(WINTER.getTime()).getTimezoneOffset());
  });

  it("restores the original implementations on uninstall", () => {
    const nativeDateTimeFormat = Intl.DateTimeFormat;
    const nativeOffset = WINTER.getTimezoneOffset();

    const installed = install();
    installed.setTimeZone("America/Los_Angeles");
    expect(WINTER.getTimezoneOffset()).toBe(480);

    installed.uninstall();
    expect(WINTER.getTimezoneOffset()).toBe(nativeOffset);
    expect(Intl.DateTimeFormat).toBe(nativeDateTimeFormat);
    expect(new Intl.DateTimeFormat("en-US").resolvedOptions().timeZone).not.toBe(
      "America/Los_Angeles",
    );
  });
});
