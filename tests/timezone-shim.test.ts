/**
 * These tests exercise the real MAIN-world timezone shim against Node's own Date and
 * Intl, which implement the same ECMAScript and timezone semantics as Firefox. That
 * makes it possible to assert the actual patch behaviour (including DST) without a
 * browser, while the shim itself stays free of Node-specific code.
 */
import { afterEach, describe, expect, it } from "vitest";
import { installTimeZoneShim, type TimeZoneShim } from "../src/content/timezone-shim";
import { getTimeZoneOffsetMinutes, getZonedParts } from "../src/shared/timezone";

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

  it("makes local Date getters agree with the active zone and leaves UTC getters alone", () => {
    const installed = install();
    installed.setTimeZone("Pacific/Auckland");
    const instant = Date.UTC(2024, 0, 15, 12, 30, 45, 250);
    const date = new Date(instant);
    const parts = getZonedParts("Pacific/Auckland", instant);

    expect(date.getFullYear()).toBe(parts.year);
    expect(date.getMonth()).toBe(parts.month - 1);
    expect(date.getDate()).toBe(parts.day);
    expect(date.getHours()).toBe(parts.hour);
    expect(date.getMinutes()).toBe(parts.minute);
    expect(date.getSeconds()).toBe(parts.second);
    expect(date.getMilliseconds()).toBe(250);
    expect(date.getDay()).toBe(
      new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay(),
    );
    expect(date.getUTCHours()).toBe(12);
    expect(date.getUTCFullYear()).toBe(2024);
    expect(date.getTimezoneOffset()).toBe(getTimeZoneOffsetMinutes("Pacific/Auckland", instant));
    expect(
      Number(
        new Intl.DateTimeFormat("en-US", {
          hour: "2-digit",
          hourCycle: "h23",
          timeZone: "Pacific/Auckland",
        }).format(date),
      ),
    ).toBe(parts.hour);
  });

  it("writes local setters as wall time in the active zone", () => {
    const installed = install();
    installed.setTimeZone("America/New_York");
    const date = new Date(Date.UTC(2024, 6, 15, 16, 0, 0, 0));

    expect(date.setHours(9, 45, 5, 10)).toBe(date.getTime());
    expect(date.getHours()).toBe(9);
    expect(date.getMinutes()).toBe(45);
    expect(date.getSeconds()).toBe(5);
    expect(date.getMilliseconds()).toBe(10);
    expect(getZonedParts("America/New_York", date.getTime())).toMatchObject({
      hour: 9,
      minute: 45,
      second: 5,
    });

    date.setMonth(0, 2);
    expect(date.getMonth()).toBe(0);
    expect(date.getDate()).toBe(2);
    expect(date.getHours()).toBe(9);

    date.setDate(40);
    expect(date.getMonth()).toBe(1);
    expect(date.getDate()).toBe(9);
  });

  it("resolves a spring-forward gap to the post-transition offset and a fold to the earlier one", () => {
    const installed = install();
    installed.setTimeZone("America/New_York");

    const gap = new Date(Date.UTC(2024, 2, 10, 12, 0, 0));
    gap.setHours(2, 30, 0, 0);
    expect(gap.getHours()).toBe(3);
    expect(gap.getMinutes()).toBe(30);
    expect(getTimeZoneOffsetMinutes("America/New_York", gap.getTime())).toBe(240);

    const fold = new Date(Date.UTC(2024, 10, 3, 12, 0, 0));
    fold.setHours(1, 30, 0, 0);
    expect(fold.getHours()).toBe(1);
    expect(fold.getMinutes()).toBe(30);
    expect(getTimeZoneOffsetMinutes("America/New_York", fold.getTime())).toBe(240);
  });
});
