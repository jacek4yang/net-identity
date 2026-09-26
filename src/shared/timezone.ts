/**
 * Timezone computations.
 *
 * IMPORTANT: a timezone is never modelled as a fixed UTC offset. Every offset is
 * derived from `Intl.DateTimeFormat` for the specific instant being rendered, so
 * daylight saving time and historical rule changes are handled by the platform
 * timezone database.
 *
 * Numeric fields and display names come from two separate formatters on purpose:
 * `Intl` cannot return both `month: "2-digit"` and `month: "short"` in one call, and
 * mixing them silently produced `NaN` offsets.
 *
 * These helpers are pure and are shared by the MAIN-world shim and the tests.
 */

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Short weekday name, for example `Mon`. */
  weekday: string;
  /** Short month name, for example `Jan`. */
  monthName: string;
}

const NUMERIC_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
const NAME_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
const ZONE_NAME_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
const CACHE_LIMIT = 16;

function memoized(
  cache: Map<string, Intl.DateTimeFormat>,
  timeZone: string,
  create: () => Intl.DateTimeFormat,
): Intl.DateTimeFormat {
  const existing = cache.get(timeZone);
  if (existing) return existing;
  const formatter = create();
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(timeZone, formatter);
  return formatter;
}

/**
 * Validates an IANA timezone identifier.
 *
 * `Intl` is the single source of truth: the value is accepted only if the platform
 * can actually construct a formatter with it, so a timezone that passes validation
 * can never throw later when it is applied to a page. (Timezone identifiers are
 * matched case-insensitively by the platform, so `utc` is accepted like `UTC`.)
 */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return true;
  } catch {
    return false;
  }
}

function numericPartsFormatter(timeZone: string): Intl.DateTimeFormat {
  return memoized(
    NUMERIC_FORMATTER_CACHE,
    timeZone,
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
  );
}

function namePartsFormatter(timeZone: string): Intl.DateTimeFormat {
  return memoized(
    NAME_FORMATTER_CACHE,
    timeZone,
    () => new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short" }),
  );
}

function readPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const found = parts.find((part) => part.type === type);
  return found ? found.value : "";
}

function readNumber(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  return Number(readPart(parts, type));
}

export function getZonedParts(timeZone: string, utcMilliseconds: number): ZonedParts {
  const date = new Date(utcMilliseconds);
  const numeric = numericPartsFormatter(timeZone).formatToParts(date);
  const names = namePartsFormatter(timeZone).formatToParts(date);

  return {
    year: readNumber(numeric, "year"),
    month: readNumber(numeric, "month"),
    day: readNumber(numeric, "day"),
    hour: readNumber(numeric, "hour"),
    minute: readNumber(numeric, "minute"),
    second: readNumber(numeric, "second"),
    weekday: readPart(names, "weekday"),
    monthName: readPart(names, "month"),
  };
}

/**
 * Offset in minutes using the sign convention of `Date.prototype.getTimezoneOffset`
 * (positive when the zone is behind UTC). DST aware: evaluated per instant.
 */
export function getTimeZoneOffsetMinutes(timeZone: string, utcMilliseconds: number): number {
  if (!Number.isFinite(utcMilliseconds)) return Number.NaN;
  const seconds = Math.floor(utcMilliseconds / 1000) * 1000;
  const parts = getZonedParts(timeZone, seconds);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const offset = -Math.round((asUtc - seconds) / 60000);
  // Normalise -0 to 0 so the result matches what native getTimezoneOffset returns.
  return offset === 0 ? 0 : offset;
}

function wallClock(utcMilliseconds: number): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const date = new Date(utcMilliseconds);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function sameWallClock(
  timeZone: string,
  utcMilliseconds: number,
  want: ReturnType<typeof wallClock>,
): boolean {
  const parts = getZonedParts(timeZone, utcMilliseconds);
  const hour = parts.hour === 24 ? 0 : parts.hour;
  return (
    parts.year === want.year &&
    parts.month === want.month &&
    parts.day === want.day &&
    hour === want.hour &&
    parts.minute === want.minute &&
    parts.second === want.second
  );
}

/**
 * UTC instant whose wall clock in `timeZone` matches the given components.
 *
 * `Date.UTC` overflow rules apply, so hour 25 or day 0 rolls into the next or
 * previous civil day. When the wall time is repeated (a fall-back fold), the
 * earlier instant is used. When it does not exist (a spring-forward gap), the
 * later candidate is used, which is the post-transition offset.
 */
export function utcFromZonedWallTime(
  timeZone: string,
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): number {
  const wallAsUtc = Date.UTC(year, monthIndex, day, hour, minute, second, millisecond);
  if (!Number.isFinite(wallAsUtc)) return Number.NaN;
  const want = wallClock(wallAsUtc);

  const candidates: number[] = [];
  let utc = wallAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offsetMinutes = getTimeZoneOffsetMinutes(timeZone, utc);
    if (!Number.isFinite(offsetMinutes)) return Number.NaN;
    const next = wallAsUtc + offsetMinutes * 60_000;
    candidates.push(next);
    if (next === utc) break;
    utc = next;
  }

  const matches = candidates.filter((candidate) => sameWallClock(timeZone, candidate, want));
  if (matches.length > 0) return Math.min(...matches);
  return Math.max(...candidates);
}

export function formatGmtOffset(offsetMinutes: number): string {
  if (!Number.isFinite(offsetMinutes)) return "GMT+0000";
  const sign = offsetMinutes > 0 ? "-" : "+";
  const absolute = Math.abs(Math.round(offsetMinutes));
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `GMT${sign}${String(hours).padStart(2, "0")}${String(minutes).padStart(2, "0")}`;
}

function zoneNameFormatter(timeZone: string, style: "long" | "short"): Intl.DateTimeFormat {
  // A per-zone, per-style cache key keeps both styles without growing unbounded.
  const key = `${style}:${timeZone}`;
  return memoized(
    ZONE_NAME_FORMATTER_CACHE,
    key,
    () => new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: style }),
  );
}

export function getTimeZoneLongName(timeZone: string, utcMilliseconds: number): string {
  const name = readPart(
    zoneNameFormatter(timeZone, "long").formatToParts(new Date(utcMilliseconds)),
    "timeZoneName",
  );
  return name === "" ? timeZone : name;
}

export function getTimeZoneShortName(timeZone: string, utcMilliseconds: number): string {
  const name = readPart(
    zoneNameFormatter(timeZone, "short").formatToParts(new Date(utcMilliseconds)),
    "timeZoneName",
  );
  return name === "" ? timeZone : name;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/** Mirrors the layout of `Date.prototype.toString` for a given IANA timezone. */
export function formatDateWithTimeZone(date: Date, timeZone: string): string {
  const utcMilliseconds = date.getTime();
  if (!Number.isFinite(utcMilliseconds)) return "Invalid Date";
  const parts = getZonedParts(timeZone, utcMilliseconds);
  const offset = formatGmtOffset(getTimeZoneOffsetMinutes(timeZone, utcMilliseconds));
  const zoneName = getTimeZoneLongName(timeZone, utcMilliseconds);
  return (
    `${parts.weekday} ${parts.monthName} ${pad(parts.day)} ${parts.year} ` +
    `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)} ${offset} (${zoneName})`
  );
}

/** Mirrors the layout of `Date.prototype.toTimeString`. */
export function formatTimeWithTimeZone(date: Date, timeZone: string): string {
  const utcMilliseconds = date.getTime();
  if (!Number.isFinite(utcMilliseconds)) return "Invalid Date";
  const parts = getZonedParts(timeZone, utcMilliseconds);
  const offset = formatGmtOffset(getTimeZoneOffsetMinutes(timeZone, utcMilliseconds));
  const zoneName = getTimeZoneLongName(timeZone, utcMilliseconds);
  return `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)} ${offset} (${zoneName})`;
}

/** Mirrors the layout of `Date.prototype.toDateString`. */
export function formatDayWithTimeZone(date: Date, timeZone: string): string {
  const utcMilliseconds = date.getTime();
  if (!Number.isFinite(utcMilliseconds)) return "Invalid Date";
  const parts = getZonedParts(timeZone, utcMilliseconds);
  return `${parts.weekday} ${parts.monthName} ${pad(parts.day)} ${parts.year}`;
}
