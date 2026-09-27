import { getTimeZoneOffsetMinutes, isValidTimeZone } from "../shared/timezone";

/** A coarse warning, never validation: political zones need not follow solar longitude. */
export function locationTimezoneWarning(
  longitude: number,
  timezone: string,
  now: number,
): string | null {
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180 || !isValidTimeZone(timezone))
    return null;
  const solarHours = longitude / 15;
  const zoneHours = -getTimeZoneOffsetMinutes(timezone, now) / 60;
  const difference = Math.abs(((zoneHours - solarHours + 36) % 24) - 12);
  return difference > 3
    ? "The manual timezone appears far from this longitude. Your choices will be applied unchanged."
    : null;
}
