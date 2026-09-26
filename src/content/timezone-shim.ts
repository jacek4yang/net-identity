/**
 * Page-level timezone shim (MAIN world).
 *
 * WHAT THIS IS: a compatibility shim that makes a page's own timezone reads agree
 * with the active identity. WHAT IT IS NOT: a change to Firefox's process
 * timezone. The browser process, other tabs, certificates and Firefox's own UI are
 * unaffected, and a sophisticated page can detect that these functions are wrapped.
 *
 * Design notes:
 *   - Offsets are always derived per instant from `Intl.DateTimeFormat` for the
 *     selected IANA zone, never as a fixed UTC offset, so DST and historical rule
 *     changes are handled by the platform.
 *   - Wrappers are installed once at `document_start` (before page scripts can
 *     capture the originals) and delegate to the native implementation whenever no
 *     identity is active, so pages behave natively while the extension is idle.
 *   - A caller that explicitly passes `timeZone` always wins.
 *   - Local Date getters and setters use the active zone's wall clock. UTC
 *     methods are left alone. Setter components follow `Date.UTC` overflow.
 *     A missing spring-forward time uses the post-transition offset, and a
 *     repeated fall-back time uses the earlier instant.
 */
import {
  formatDateWithTimeZone,
  formatDayWithTimeZone,
  formatTimeWithTimeZone,
  getTimeZoneOffsetMinutes,
  getZonedParts,
  isValidTimeZone,
  utcFromZonedWallTime,
  type ZonedParts,
} from "../shared/timezone";

export interface TimeZoneShimScope {
  date: typeof Date;
  intl: typeof Intl;
}

export interface TimeZoneShim {
  readonly installed: boolean;
  setTimeZone(timeZone: string | null): void;
  getTimeZone(): string | null;
  /** Restores the original implementations. Used by tests. */
  uninstall(): void;
}

const MAX_TIME_ZONE_LENGTH = 64;

function hasExplicitTimeZone(options: Intl.DateTimeFormatOptions | undefined): boolean {
  return options !== undefined && options !== null && options.timeZone !== undefined;
}

export function installTimeZoneShim(scope: TimeZoneShimScope): TimeZoneShim {
  const DateCtor = scope.date;
  const IntlObject = scope.intl;
  const datePrototype = DateCtor.prototype;
  // `getYear`/`setYear` remain on Firefox's Date prototype but are absent from
  // the TypeScript DOM lib. They are patched so a legacy caller cannot observe
  // the host year.
  const legacyPrototype = datePrototype as Date & {
    getYear(this: Date): number;
    setYear(this: Date, year: number): number;
  };

  // The shim deliberately keeps unbound references to the natives so it can
  // delegate to them with the caller's own receiver.
  /* eslint-disable @typescript-eslint/unbound-method */
  const originalGetTimeZoneOffset = datePrototype.getTimezoneOffset;
  const originalGetFullYear = datePrototype.getFullYear;
  const originalGetMonth = datePrototype.getMonth;
  const originalGetDate = datePrototype.getDate;
  const originalGetDay = datePrototype.getDay;
  const originalGetHours = datePrototype.getHours;
  const originalGetMinutes = datePrototype.getMinutes;
  const originalGetSeconds = datePrototype.getSeconds;
  const originalGetMilliseconds = datePrototype.getMilliseconds;
  const originalGetYear = legacyPrototype.getYear;
  const originalSetFullYear = datePrototype.setFullYear;
  const originalSetMonth = datePrototype.setMonth;
  const originalSetDate = datePrototype.setDate;
  const originalSetHours = datePrototype.setHours;
  const originalSetMinutes = datePrototype.setMinutes;
  const originalSetSeconds = datePrototype.setSeconds;
  const originalSetMilliseconds = datePrototype.setMilliseconds;
  const originalSetYear = legacyPrototype.setYear;
  const originalToString = datePrototype.toString;
  const originalToTimeString = datePrototype.toTimeString;
  const originalToDateString = datePrototype.toDateString;
  const originalToLocaleString = datePrototype.toLocaleString;
  const originalToLocaleDateString = datePrototype.toLocaleDateString;
  const originalToLocaleTimeString = datePrototype.toLocaleTimeString;
  /* eslint-enable @typescript-eslint/unbound-method */
  const NativeDateTimeFormat = IntlObject.DateTimeFormat;

  let activeTimeZone: string | null = null;

  /** Injects the active zone unless the caller explicitly asked for one. */
  const patchDateTimeFormatArguments = (args: readonly unknown[]): unknown[] => {
    if (activeTimeZone === null) return [...args];
    const locales = args[0];
    const options = args[1];

    if (options === undefined) return [locales, { timeZone: activeTimeZone }];
    if (options === null) return [locales, { timeZone: activeTimeZone }];
    if (typeof options !== "object") return [...args];
    if (hasExplicitTimeZone(options)) return [...args];
    return [locales, { ...options, timeZone: activeTimeZone }];
  };

  const patchedDateTimeFormat = new Proxy(NativeDateTimeFormat, {
    construct(target, args, newTarget) {
      return Reflect.construct(
        target,
        patchDateTimeFormatArguments(args),
        newTarget,
      ) as Intl.DateTimeFormat;
    },
    apply(target, thisArgument, args) {
      return Reflect.apply(
        target,
        thisArgument,
        patchDateTimeFormatArguments(args),
      ) as Intl.DateTimeFormat;
    },
  });

  function zonedParts(date: Date): ZonedParts | null {
    if (activeTimeZone === null) return null;
    const time = date.getTime();
    if (Number.isNaN(time)) return null;
    const parts = getZonedParts(activeTimeZone, time);
    // Some ICU builds report midnight as hour 24 of the previous civil day.
    if (parts.hour !== 24) return parts;
    const midnight = new Date(
      Date.UTC(parts.year, parts.month - 1, parts.day) + 24 * 60 * 60 * 1000,
    );
    return {
      ...parts,
      year: midnight.getUTCFullYear(),
      month: midnight.getUTCMonth() + 1,
      day: midnight.getUTCDate(),
      hour: 0,
    };
  }

  function weekday(parts: ZonedParts): number {
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  }

  function keep(value: number | undefined, current: number): number {
    return value === undefined ? current : value;
  }

  function writeWallTime(
    date: Date,
    year: number,
    monthIndex: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    millisecond: number,
  ): number {
    if (activeTimeZone === null) return Number.NaN;
    const utc = utcFromZonedWallTime(
      activeTimeZone,
      year,
      monthIndex,
      day,
      hour,
      minute,
      second,
      millisecond,
    );
    date.setTime(utc);
    return date.getTime();
  }

  function patchedGetFullYear(this: Date): number {
    const parts = zonedParts(this);
    return parts === null ? originalGetFullYear.call(this) : parts.year;
  }

  function patchedGetMonth(this: Date): number {
    const parts = zonedParts(this);
    return parts === null ? originalGetMonth.call(this) : parts.month - 1;
  }

  function patchedGetDate(this: Date): number {
    const parts = zonedParts(this);
    return parts === null ? originalGetDate.call(this) : parts.day;
  }

  function patchedGetDay(this: Date): number {
    const parts = zonedParts(this);
    return parts === null ? originalGetDay.call(this) : weekday(parts);
  }

  function patchedGetHours(this: Date): number {
    const parts = zonedParts(this);
    return parts === null ? originalGetHours.call(this) : parts.hour;
  }

  function patchedGetMinutes(this: Date): number {
    const parts = zonedParts(this);
    return parts === null ? originalGetMinutes.call(this) : parts.minute;
  }

  function patchedGetSeconds(this: Date): number {
    const parts = zonedParts(this);
    return parts === null ? originalGetSeconds.call(this) : parts.second;
  }

  function patchedGetYear(this: Date): number {
    const parts = zonedParts(this);
    return parts === null ? originalGetYear.call(this) : parts.year - 1900;
  }

  function patchedSetFullYear(this: Date, year: number, month?: number, date?: number): number {
    const parts = zonedParts(this);
    if (parts === null)
      return originalSetFullYear.call(this, year, month as number, date as number);
    return writeWallTime(
      this,
      year,
      keep(month, parts.month - 1),
      keep(date, parts.day),
      parts.hour,
      parts.minute,
      parts.second,
      originalGetMilliseconds.call(this),
    );
  }

  function patchedSetMonth(this: Date, month: number, date?: number): number {
    const parts = zonedParts(this);
    if (parts === null) return originalSetMonth.call(this, month, date as number);
    return writeWallTime(
      this,
      parts.year,
      month,
      keep(date, parts.day),
      parts.hour,
      parts.minute,
      parts.second,
      originalGetMilliseconds.call(this),
    );
  }

  function patchedSetDate(this: Date, date: number): number {
    const parts = zonedParts(this);
    if (parts === null) return originalSetDate.call(this, date);
    return writeWallTime(
      this,
      parts.year,
      parts.month - 1,
      date,
      parts.hour,
      parts.minute,
      parts.second,
      originalGetMilliseconds.call(this),
    );
  }

  function patchedSetHours(
    this: Date,
    hour: number,
    minute?: number,
    second?: number,
    millisecond?: number,
  ): number {
    const parts = zonedParts(this);
    if (parts === null) {
      return originalSetHours.call(
        this,
        hour,
        minute as number,
        second as number,
        millisecond as number,
      );
    }
    return writeWallTime(
      this,
      parts.year,
      parts.month - 1,
      parts.day,
      hour,
      keep(minute, parts.minute),
      keep(second, parts.second),
      keep(millisecond, originalGetMilliseconds.call(this)),
    );
  }

  function patchedSetMinutes(
    this: Date,
    minute: number,
    second?: number,
    millisecond?: number,
  ): number {
    const parts = zonedParts(this);
    if (parts === null) {
      return originalSetMinutes.call(this, minute, second as number, millisecond as number);
    }
    return writeWallTime(
      this,
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      minute,
      keep(second, parts.second),
      keep(millisecond, originalGetMilliseconds.call(this)),
    );
  }

  function patchedSetSeconds(this: Date, second: number, millisecond?: number): number {
    const parts = zonedParts(this);
    if (parts === null) return originalSetSeconds.call(this, second, millisecond as number);
    return writeWallTime(
      this,
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      second,
      keep(millisecond, originalGetMilliseconds.call(this)),
    );
  }

  function patchedSetMilliseconds(this: Date, millisecond: number): number {
    const parts = zonedParts(this);
    if (parts === null) return originalSetMilliseconds.call(this, millisecond);
    return writeWallTime(
      this,
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      millisecond,
    );
  }

  function patchedSetYear(this: Date, year: number): number {
    const fullYear = year >= 0 && year <= 99 ? year + 1900 : year;
    return patchedSetFullYear.call(this, fullYear);
  }

  function patchedGetTimeZoneOffset(this: Date): number {
    if (activeTimeZone === null) return originalGetTimeZoneOffset.call(this);
    const time = this.getTime();
    if (Number.isNaN(time)) return Number.NaN;
    return getTimeZoneOffsetMinutes(activeTimeZone, time);
  }

  function patchedToString(this: Date): string {
    if (activeTimeZone === null) return originalToString.call(this);
    const time = this.getTime();
    if (Number.isNaN(time)) return originalToString.call(this);
    return formatDateWithTimeZone(this, activeTimeZone);
  }

  function patchedToTimeString(this: Date): string {
    if (activeTimeZone === null) return originalToTimeString.call(this);
    const time = this.getTime();
    if (Number.isNaN(time)) return originalToTimeString.call(this);
    return formatTimeWithTimeZone(this, activeTimeZone);
  }

  function patchedToDateString(this: Date): string {
    if (activeTimeZone === null) return originalToDateString.call(this);
    const time = this.getTime();
    if (Number.isNaN(time)) return originalToDateString.call(this);
    return formatDayWithTimeZone(this, activeTimeZone);
  }

  function localeOptions(options: unknown): Intl.DateTimeFormatOptions | undefined {
    if (activeTimeZone === null) return options as Intl.DateTimeFormatOptions | undefined;
    // Only object options can carry a timezone; anything else is passed through.
    if (options === undefined || options === null) return { timeZone: activeTimeZone };
    if (typeof options !== "object") return undefined;
    if (hasExplicitTimeZone(options)) return options;
    return { ...options, timeZone: activeTimeZone };
  }

  function patchedToLocaleString(
    this: Date,
    locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
  ): string {
    if (activeTimeZone === null) return originalToLocaleString.call(this, locales, options);
    const merged = localeOptions(options);
    return merged === undefined
      ? originalToLocaleString.call(this, locales)
      : originalToLocaleString.call(this, locales, merged);
  }

  function patchedToLocaleDateString(
    this: Date,
    locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
  ): string {
    if (activeTimeZone === null) return originalToLocaleDateString.call(this, locales, options);
    const merged = localeOptions(options);
    return merged === undefined
      ? originalToLocaleDateString.call(this, locales)
      : originalToLocaleDateString.call(this, locales, merged);
  }

  function patchedToLocaleTimeString(
    this: Date,
    locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
  ): string {
    if (activeTimeZone === null) return originalToLocaleTimeString.call(this, locales, options);
    const merged = localeOptions(options);
    return merged === undefined
      ? originalToLocaleTimeString.call(this, locales)
      : originalToLocaleTimeString.call(this, locales, merged);
  }

  const restore = (): void => {
    datePrototype.getTimezoneOffset = originalGetTimeZoneOffset;
    datePrototype.getFullYear = originalGetFullYear;
    datePrototype.getMonth = originalGetMonth;
    datePrototype.getDate = originalGetDate;
    datePrototype.getDay = originalGetDay;
    datePrototype.getHours = originalGetHours;
    datePrototype.getMinutes = originalGetMinutes;
    datePrototype.getSeconds = originalGetSeconds;
    datePrototype.getMilliseconds = originalGetMilliseconds;
    legacyPrototype.getYear = originalGetYear;
    datePrototype.setFullYear = originalSetFullYear;
    datePrototype.setMonth = originalSetMonth;
    datePrototype.setDate = originalSetDate;
    datePrototype.setHours = originalSetHours;
    datePrototype.setMinutes = originalSetMinutes;
    datePrototype.setSeconds = originalSetSeconds;
    datePrototype.setMilliseconds = originalSetMilliseconds;
    legacyPrototype.setYear = originalSetYear;
    datePrototype.toString = originalToString;
    datePrototype.toTimeString = originalToTimeString;
    datePrototype.toDateString = originalToDateString;
    datePrototype.toLocaleString = originalToLocaleString;
    datePrototype.toLocaleDateString = originalToLocaleDateString;
    datePrototype.toLocaleTimeString = originalToLocaleTimeString;
    IntlObject.DateTimeFormat = NativeDateTimeFormat;
  };

  // Install the wrappers immediately: waiting for an identity would let page
  // scripts capture unwrapped references first.
  datePrototype.getTimezoneOffset = patchedGetTimeZoneOffset;
  datePrototype.getFullYear = patchedGetFullYear;
  datePrototype.getMonth = patchedGetMonth;
  datePrototype.getDate = patchedGetDate;
  datePrototype.getDay = patchedGetDay;
  datePrototype.getHours = patchedGetHours;
  datePrototype.getMinutes = patchedGetMinutes;
  datePrototype.getSeconds = patchedGetSeconds;
  legacyPrototype.getYear = patchedGetYear;
  datePrototype.setFullYear = patchedSetFullYear;
  datePrototype.setMonth = patchedSetMonth;
  datePrototype.setDate = patchedSetDate;
  datePrototype.setHours = patchedSetHours;
  datePrototype.setMinutes = patchedSetMinutes;
  datePrototype.setSeconds = patchedSetSeconds;
  datePrototype.setMilliseconds = patchedSetMilliseconds;
  legacyPrototype.setYear = patchedSetYear;
  datePrototype.toString = patchedToString;
  datePrototype.toTimeString = patchedToTimeString;
  datePrototype.toDateString = patchedToDateString;
  datePrototype.toLocaleString = patchedToLocaleString;
  datePrototype.toLocaleDateString = patchedToLocaleDateString;
  datePrototype.toLocaleTimeString = patchedToLocaleTimeString;
  IntlObject.DateTimeFormat = patchedDateTimeFormat;

  return {
    installed: true,

    setTimeZone(timeZone: string | null): void {
      if (timeZone === null) {
        activeTimeZone = null;
        return;
      }
      if (
        typeof timeZone !== "string" ||
        timeZone.length === 0 ||
        timeZone.length > MAX_TIME_ZONE_LENGTH
      ) {
        activeTimeZone = null;
        return;
      }
      activeTimeZone = isValidTimeZone(timeZone) ? timeZone : null;
    },

    getTimeZone(): string | null {
      return activeTimeZone;
    },

    uninstall(): void {
      activeTimeZone = null;
      restore();
    },
  };
}
