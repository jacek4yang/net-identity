import { describe, expect, it } from "vitest";
import {
  formatDateWithTimeZone,
  formatDayWithTimeZone,
  formatGmtOffset,
  formatTimeWithTimeZone,
  getTimeZoneLongName,
  getTimeZoneOffsetMinutes,
  getZonedParts,
  isValidTimeZone,
  utcFromZonedWallTime,
} from "../src/shared/timezone";

function intlAccepts(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

describe("isValidTimeZone", () => {
  it("accepts valid IANA identifiers", () => {
    for (const zone of [
      "UTC",
      "Etc/UTC",
      "America/Los_Angeles",
      "Europe/Amsterdam",
      "Asia/Kolkata",
      "US/Pacific",
    ]) {
      expect(isValidTimeZone(zone), zone).toBe(true);
    }
  });

  it("rejects identifiers the platform cannot use", () => {
    for (const zone of [
      "Mars/Olympus",
      "GMT+2",
      "Not/AZone",
      "America/Not_A_Zone",
      "  ",
      "A".repeat(80),
      42,
      null,
      undefined,
    ]) {
      expect(isValidTimeZone(zone), String(zone)).toBe(false);
    }
  });

  it("stays in agreement with Intl, including case-insensitive identifiers", () => {
    for (const zone of ["utc", "UTC", "europe/amsterdam", "Mars/Olympus"]) {
      expect(isValidTimeZone(zone), zone).toBe(intlAccepts(zone));
    }
  });
});

describe("getTimeZoneOffsetMinutes", () => {
  it("uses the getTimezoneOffset sign convention (positive west of UTC)", () => {
    expect(getTimeZoneOffsetMinutes("UTC", Date.UTC(2024, 0, 1))).toBe(0);
    expect(getTimeZoneOffsetMinutes("Asia/Kolkata", Date.UTC(2024, 0, 1))).toBe(-330);
    expect(getTimeZoneOffsetMinutes("America/Los_Angeles", Date.UTC(2024, 0, 15, 20))).toBe(480);
  });

  it("follows daylight saving time instead of using a fixed offset", () => {
    const winter = Date.UTC(2024, 0, 15, 20);
    const summer = Date.UTC(2024, 6, 15, 19);

    expect(getTimeZoneOffsetMinutes("America/Los_Angeles", winter)).toBe(480); // PST (UTC-8)
    expect(getTimeZoneOffsetMinutes("America/Los_Angeles", summer)).toBe(420); // PDT (UTC-7)
    expect(getTimeZoneOffsetMinutes("Europe/Amsterdam", winter)).toBe(-60); // CET (UTC+1)
    expect(getTimeZoneOffsetMinutes("Europe/Amsterdam", summer)).toBe(-120); // CEST (UTC+2)
  });

  it("switches exactly at the DST transition instant", () => {
    // Los Angeles moved to DST at 2024-03-10T10:00Z (02:00 local standard time).
    expect(getTimeZoneOffsetMinutes("America/Los_Angeles", Date.UTC(2024, 2, 10, 9, 59))).toBe(480);
    expect(getTimeZoneOffsetMinutes("America/Los_Angeles", Date.UTC(2024, 2, 10, 10, 0))).toBe(420);
    // ...and back on 2024-11-03T09:00Z (02:00 local daylight time).
    expect(getTimeZoneOffsetMinutes("America/Los_Angeles", Date.UTC(2024, 10, 3, 8, 59))).toBe(420);
    expect(getTimeZoneOffsetMinutes("America/Los_Angeles", Date.UTC(2024, 10, 3, 9, 0))).toBe(480);
  });

  it("applies historical rules for old timestamps", () => {
    // 1970-01-01: the Netherlands used UTC+1 all year, but the US used standard time.
    expect(getTimeZoneOffsetMinutes("Europe/Amsterdam", Date.UTC(1970, 0, 1))).toBe(-60);
    expect(getTimeZoneOffsetMinutes("America/Los_Angeles", Date.UTC(1970, 0, 1))).toBe(480);
  });

  it("returns NaN for an invalid timestamp", () => {
    expect(Number.isNaN(getTimeZoneOffsetMinutes("UTC", Number.NaN))).toBe(true);
    expect(Number.isNaN(getTimeZoneOffsetMinutes("UTC", Number.POSITIVE_INFINITY))).toBe(true);
  });
});

describe("getZonedParts", () => {
  it("returns the local calendar fields for the instant", () => {
    const parts = getZonedParts("America/Los_Angeles", Date.UTC(2024, 0, 1, 12, 30, 45));
    expect(parts).toMatchObject({
      year: 2024,
      month: 1,
      day: 1,
      hour: 4,
      minute: 30,
      second: 45,
      weekday: "Mon",
    });
  });

  it("uses a 00-23 hour cycle", () => {
    const midnight = getZonedParts("UTC", Date.UTC(2024, 5, 2, 0, 0, 0));
    expect(midnight.hour).toBe(0);
    expect(midnight.day).toBe(2);
  });
});

describe("formatting", () => {
  const instant = new Date(Date.UTC(2024, 0, 1, 12, 0, 0));

  it("formats offset labels", () => {
    expect(formatGmtOffset(480)).toBe("GMT-0800");
    expect(formatGmtOffset(-330)).toBe("GMT+0530");
    expect(formatGmtOffset(0)).toBe("GMT+0000");
    expect(formatGmtOffset(-45.4)).toBe("GMT+0045");
  });

  it("mirrors Date.prototype.toString for a fixed instant", () => {
    expect(formatDateWithTimeZone(instant, "America/Los_Angeles")).toMatch(
      /^Mon Jan 01 2024 04:00:00 GMT-0800 \(Pacific .*Time\)$/,
    );
    expect(formatDateWithTimeZone(instant, "UTC")).toMatch(
      /^Mon Jan 01 2024 12:00:00 GMT\+0000 \(.*\)$/,
    );
  });

  it("mirrors toTimeString and toDateString", () => {
    expect(formatTimeWithTimeZone(instant, "America/Los_Angeles")).toMatch(
      /^04:00:00 GMT-0800 \(Pacific .*Time\)$/,
    );
    expect(formatDayWithTimeZone(instant, "America/Los_Angeles")).toBe("Mon Jan 01 2024");
  });

  it("reports Invalid Date for an invalid date", () => {
    const invalid = new Date(Number.NaN);
    expect(formatDateWithTimeZone(invalid, "UTC")).toBe("Invalid Date");
    expect(formatTimeWithTimeZone(invalid, "UTC")).toBe("Invalid Date");
    expect(formatDayWithTimeZone(invalid, "UTC")).toBe("Invalid Date");
  });

  it("exposes the long zone name for the instant, including DST variants", () => {
    const winter = getTimeZoneLongName("America/Los_Angeles", Date.UTC(2024, 0, 15));
    const summer = getTimeZoneLongName("America/Los_Angeles", Date.UTC(2024, 6, 15));
    expect(winter).toContain("Pacific");
    expect(summer).toContain("Pacific");
    expect(winter).not.toBe(summer);
  });
});

describe("utcFromZonedWallTime", () => {
  it("round-trips a winter and summer wall time", () => {
    const winter = utcFromZonedWallTime("America/Los_Angeles", 2024, 0, 15, 4, 30, 0, 0);
    expect(getZonedParts("America/Los_Angeles", winter)).toMatchObject({
      year: 2024,
      month: 1,
      day: 15,
      hour: 4,
      minute: 30,
    });
    expect(getTimeZoneOffsetMinutes("America/Los_Angeles", winter)).toBe(480);

    const summer = utcFromZonedWallTime("America/Los_Angeles", 2024, 6, 15, 4, 30, 0, 0);
    expect(getZonedParts("America/Los_Angeles", summer).hour).toBe(4);
    expect(getTimeZoneOffsetMinutes("America/Los_Angeles", summer)).toBe(420);
  });

  it("rolls overflowed components into the next civil day", () => {
    const utc = utcFromZonedWallTime("UTC", 2024, 0, 31, 25, 0, 0, 0);
    expect(getZonedParts("UTC", utc)).toMatchObject({ month: 2, day: 1, hour: 1 });
  });
});
