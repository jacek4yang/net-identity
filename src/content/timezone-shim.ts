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
 */
import {
  formatDateWithTimeZone,
  formatDayWithTimeZone,
  formatTimeWithTimeZone,
  getTimeZoneOffsetMinutes,
  isValidTimeZone,
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

  // The shim deliberately keeps unbound references to the natives so it can
  // delegate to them with the caller's own receiver.
  /* eslint-disable @typescript-eslint/unbound-method */
  const originalGetTimeZoneOffset = datePrototype.getTimezoneOffset;
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
