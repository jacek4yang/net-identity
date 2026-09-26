/**
 * Page-level Geolocation shim (MAIN world).
 *
 * Overrides `navigator.geolocation.getCurrentPosition`, `watchPosition` and
 * `clearWatch` so that pages see the identity of the active profile.
 *
 * Fail-closed rules:
 *   - native geolocation is called only after the extension reports that no
 *     profile is active (`release`)
 *   - while a position is known, including during a later activation, that
 *     position is served until a new one is committed
 *   - while identity is pending and no position is known, calls wait and then
 *     receive a timeout error
 *   - a committed profile with no coordinates returns position-unavailable
 *   - `enableHighAccuracy` never bypasses these rules
 *
 * Callbacks stay asynchronous. Returned positions are real prototype instances.
 */
import { CONTENT_IDENTITY_WAIT_MS } from "../shared/constants";
import type { IdentityEnvelope } from "../shared/public-identity";

export interface GeoTarget {
  latitude: number;
  longitude: number;
  accuracy: number;
}

/** PositionError constants, mirrored so the shim never depends on globals. */
export const PERMISSION_DENIED = 1;
export const POSITION_UNAVAILABLE = 2;
export const POSITION_TIMEOUT = 3;

export interface PositionFactories {
  /** Only `prototype` is needed: Firefox exposes no constructor for these types. */
  positionCtor: { prototype: object } | undefined;
  coordinatesCtor: { prototype: object } | undefined;
  errorCtor: { prototype: object } | undefined;
  now: () => number;
}

export interface GeolocationRealm {
  geolocation: Geolocation;
  permissions?: Permissions | undefined;
  positionCtor?: { prototype: object } | undefined;
  coordinatesCtor?: { prototype: object } | undefined;
  errorCtor?: { prototype: object } | undefined;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => number;
  cancel?: (handle: number) => void;
}

function defineValues(target: object, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: false,
    });
  }
}

/**
 * Creates the shell of a platform object from its real prototype without calling a
 * constructor (Firefox exposes none for these types).
 *
 * `Object.create` is typed as `any`, so the single narrowing assertion of the
 * content scripts lives here; it is never applied to untrusted input.
 */
function createFromPrototype(ctor: { prototype: object } | undefined): object {
  return ctor === undefined ? {} : (Object.create(ctor.prototype) as object);
}

/**
 * Builds a `GeolocationPosition` look-alike.
 *
 * Firefox provides no constructor for these platform objects, so the object is
 * created from the real prototype with own enumerable properties, which keeps
 * `instanceof`, property access, `JSON.stringify` and `structuredClone` working.
 */
export function createPositionLike(
  target: GeoTarget,
  factories: PositionFactories,
): GeolocationPosition {
  const coords = createFromPrototype(factories.coordinatesCtor);

  defineValues(coords, {
    latitude: target.latitude,
    longitude: target.longitude,
    accuracy: target.accuracy,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
  });

  const position = createFromPrototype(factories.positionCtor);
  defineValues(position, { coords, timestamp: factories.now() });

  return position as GeolocationPosition;
}

export function createErrorLike(
  code: number,
  message: string,
  factories: PositionFactories,
): GeolocationPositionError {
  const error = createFromPrototype(factories.errorCtor);
  defineValues(error, {
    code,
    message,
    PERMISSION_DENIED,
    POSITION_UNAVAILABLE,
    TIMEOUT: POSITION_TIMEOUT,
  });
  return error as GeolocationPositionError;
}

export type GeolocationCommand =
  | { type: "release" }
  | { type: "hold" }
  | { type: "unavailable" }
  | { type: "position"; target: GeoTarget };

/**
 * Maps an identity envelope onto one geolocation action.
 *
 * A pending envelope keeps the previous position when the new one is not known
 * yet. Native geolocation is selected only when the extension is idle.
 */
export function geolocationCommandForEnvelope(envelope: IdentityEnvelope): GeolocationCommand {
  const payload = envelope.payload;
  if (
    payload !== null &&
    payload.latitude !== undefined &&
    payload.longitude !== undefined &&
    payload.accuracy !== undefined
  ) {
    return {
      type: "position",
      target: {
        latitude: payload.latitude,
        longitude: payload.longitude,
        accuracy: payload.accuracy,
      },
    };
  }
  if (envelope.pending || envelope.controlled) {
    return envelope.pending ? { type: "hold" } : { type: "unavailable" };
  }
  return { type: "release" };
}

export interface GeolocationShim {
  readonly installed: boolean;
  /** A synthetic position is known. Native geolocation stays blocked. */
  setPosition(target: GeoTarget): void;
  /** Keep the current position, or wait if there is not one yet. Never calls native. */
  hold(): void;
  /** The active profile has no coordinates. Callers receive position-unavailable. */
  unavailable(): void;
  /** No profile is active. Later calls, and calls still waiting, use native geolocation. */
  release(): void;
  getTarget(): GeoTarget | null;
  uninstall(): void;
}

interface Waiter {
  success: PositionCallback | undefined;
  error: PositionErrorCallback | undefined;
  timer: number | undefined;
  options: PositionOptions | undefined;
  receiver: Geolocation;
}

interface Watcher {
  success: PositionCallback | undefined;
  error: PositionErrorCallback | undefined;
  timer: number | undefined;
  options: PositionOptions | undefined;
  receiver: Geolocation;
  /** Native watch id, set only after the extension has released control. */
  delegatedId: number | undefined;
}

function noopShim(): GeolocationShim {
  return {
    installed: false,
    setPosition() {
      // No geolocation API in this context (for example a sandboxed frame).
    },
    hold() {
      // Nothing to hold.
    },
    unavailable() {
      // Nothing to reject.
    },
    release() {
      // Nothing was patched.
    },
    getTarget() {
      return null;
    },
    uninstall() {
      // Nothing was patched.
    },
  };
}

function defaultSchedule(callback: () => void, delayMs: number): number {
  return setTimeout(callback, delayMs) as unknown as number;
}

function defaultCancel(handle: number): void {
  clearTimeout(handle);
}

function waitLimit(options: PositionOptions | undefined): number {
  const requested = options?.timeout;
  if (typeof requested === "number" && Number.isFinite(requested) && requested >= 0) {
    return Math.min(requested, CONTENT_IDENTITY_WAIT_MS);
  }
  return CONTENT_IDENTITY_WAIT_MS;
}

export function installGeolocationShim(realm?: GeolocationRealm): GeolocationShim {
  const geolocation =
    realm?.geolocation ?? (typeof navigator === "undefined" ? undefined : navigator.geolocation);
  if (geolocation === undefined || geolocation === null) return noopShim();

  const proto = Object.getPrototypeOf(geolocation) as Geolocation;
  // The shim deliberately keeps unbound references so it can re-apply the native
  // implementation to whichever receiver a page used.
  /* eslint-disable @typescript-eslint/unbound-method */
  const originalGetCurrentPosition = proto.getCurrentPosition;
  const originalWatchPosition = proto.watchPosition;
  const originalClearWatch = proto.clearWatch;
  /* eslint-enable @typescript-eslint/unbound-method */

  const schedule = realm?.schedule ?? defaultSchedule;
  const cancel = realm?.cancel ?? defaultCancel;
  const factories: PositionFactories = {
    positionCtor:
      realm?.positionCtor ??
      (typeof GeolocationPosition === "undefined" ? undefined : GeolocationPosition),
    coordinatesCtor:
      realm?.coordinatesCtor ??
      (typeof GeolocationCoordinates === "undefined" ? undefined : GeolocationCoordinates),
    errorCtor:
      realm?.errorCtor ??
      (typeof GeolocationPositionError === "undefined" ? undefined : GeolocationPositionError),
    now: realm?.now ?? (() => Date.now()),
  };

  let position: GeoTarget | null = null;
  let allowNative = false;
  let failImmediately = false;
  let nextWatchId = 1_000_000;
  const waiters = new Set<Waiter>();
  const watchers = new Map<number, Watcher>();

  const noopPosition: PositionCallback = () => undefined;

  function deliverPosition(success: PositionCallback | undefined, current: GeoTarget): void {
    if (success === undefined) return;
    schedule(() => {
      try {
        success(createPositionLike(current, factories));
      } catch {
        // A page callback that throws is not our problem.
      }
    }, 0);
  }

  function deliverError(
    error: PositionErrorCallback | undefined,
    code: number,
    message: string,
  ): void {
    if (error === undefined) return;
    schedule(() => {
      try {
        error(createErrorLike(code, message, factories));
      } catch {
        // Ignore page callback failures.
      }
    }, 0);
  }

  function flushWaiters(current: GeoTarget): void {
    for (const waiter of [...waiters]) {
      if (waiter.timer !== undefined) cancel(waiter.timer);
      waiters.delete(waiter);
      deliverPosition(waiter.success, current);
    }
  }

  function rejectWaiters(code: number, message: string): void {
    for (const waiter of [...waiters]) {
      if (waiter.timer !== undefined) cancel(waiter.timer);
      waiters.delete(waiter);
      deliverError(waiter.error, code, message);
    }
  }

  function delegateWaiter(waiter: Waiter): void {
    originalGetCurrentPosition.call(
      waiter.receiver,
      waiter.success ?? noopPosition,
      waiter.error ?? null,
      waiter.options,
    );
  }

  function delegateWatcher(watcher: Watcher): void {
    if (watcher.delegatedId !== undefined) return;
    watcher.delegatedId = originalWatchPosition.call(
      watcher.receiver,
      watcher.success ?? noopPosition,
      watcher.error ?? null,
      watcher.options,
    );
  }

  function patchedGetCurrentPosition(
    this: Geolocation,
    successCallback?: PositionCallback | null,
    errorCallback?: PositionErrorCallback | null,
    options?: PositionOptions,
  ): void {
    const current = position;
    if (current !== null) {
      deliverPosition(successCallback ?? undefined, current);
      return;
    }
    if (allowNative) {
      originalGetCurrentPosition.call(
        this,
        successCallback ?? noopPosition,
        errorCallback ?? null,
        options,
      );
      return;
    }
    if (failImmediately) {
      deliverError(
        errorCallback ?? undefined,
        POSITION_UNAVAILABLE,
        "No network identity location is available.",
      );
      return;
    }

    const waiter: Waiter = {
      success: successCallback ?? undefined,
      error: errorCallback ?? undefined,
      timer: undefined,
      options,
      receiver: this,
    };
    waiter.timer = schedule(() => {
      if (!waiters.has(waiter)) return;
      waiters.delete(waiter);
      // Still unresolved and still controlled: time out. Never call native here.
      deliverError(waiter.error, POSITION_TIMEOUT, "Network identity did not resolve in time.");
    }, waitLimit(options));
    waiters.add(waiter);
  }

  function patchedWatchPosition(
    this: Geolocation,
    successCallback?: PositionCallback | null,
    errorCallback?: PositionErrorCallback | null,
    options?: PositionOptions,
  ): number {
    if (allowNative && position === null) {
      return originalWatchPosition.call(
        this,
        successCallback ?? noopPosition,
        errorCallback ?? null,
        options,
      );
    }

    const watchId = nextWatchId;
    nextWatchId += 1;
    const watcher: Watcher = {
      success: successCallback ?? undefined,
      error: errorCallback ?? undefined,
      timer: undefined,
      options,
      receiver: this,
      delegatedId: undefined,
    };
    watchers.set(watchId, watcher);

    const current = position;
    if (current !== null) {
      deliverPosition(successCallback ?? undefined, current);
      return watchId;
    }
    if (failImmediately) {
      deliverError(
        errorCallback ?? undefined,
        POSITION_UNAVAILABLE,
        "No network identity location is available.",
      );
      return watchId;
    }

    watcher.timer = schedule(() => {
      if (watcher.timer === undefined) return;
      watcher.timer = undefined;
      deliverError(watcher.error, POSITION_TIMEOUT, "Network identity did not resolve in time.");
    }, waitLimit(options));
    return watchId;
  }

  function patchedClearWatch(this: Geolocation, watchId?: number): void {
    if (typeof watchId !== "number") return;

    const watcher = watchers.get(watchId);
    if (watcher !== undefined) {
      if (watcher.timer !== undefined) cancel(watcher.timer);
      if (watcher.delegatedId !== undefined) originalClearWatch.call(this, watcher.delegatedId);
      watchers.delete(watchId);
      return;
    }
    if (allowNative) originalClearWatch.call(this, watchId);
  }

  proto.getCurrentPosition = patchedGetCurrentPosition;
  proto.watchPosition = patchedWatchPosition;
  proto.clearWatch = patchedClearWatch;

  const permissions =
    realm?.permissions ?? (typeof navigator === "undefined" ? undefined : navigator.permissions);
  const permissionsPrototype =
    permissions === undefined || permissions === null
      ? undefined
      : (Object.getPrototypeOf(permissions) as Permissions | null);
  /* eslint-disable @typescript-eslint/unbound-method */
  const originalQuery =
    permissionsPrototype === undefined || permissionsPrototype === null
      ? undefined
      : permissionsPrototype.query;
  /* eslint-enable @typescript-eslint/unbound-method */

  function grantedGeolocationPermission(): PermissionStatus {
    const status =
      typeof PermissionStatus === "undefined"
        ? {}
        : (Object.create(PermissionStatus.prototype) as object);
    defineValues(status, { state: "granted", name: "geolocation", onchange: null });
    return status as PermissionStatus;
  }

  function patchedQuery(
    this: Permissions,
    descriptor?: PermissionDescriptor,
  ): Promise<PermissionStatus> {
    const name =
      descriptor !== undefined && descriptor !== null && typeof descriptor === "object"
        ? descriptor.name
        : undefined;
    if (name === "geolocation" && !allowNative) {
      return Promise.resolve(grantedGeolocationPermission());
    }
    if (originalQuery === undefined)
      return Promise.reject(new TypeError("Permissions.query is unavailable"));
    return originalQuery.call(this, descriptor as PermissionDescriptor);
  }

  if (
    permissionsPrototype !== undefined &&
    permissionsPrototype !== null &&
    originalQuery !== undefined
  ) {
    permissionsPrototype.query = patchedQuery;
  }

  return {
    installed: true,

    setPosition(next: GeoTarget): void {
      position = next;
      allowNative = false;
      failImmediately = false;
      flushWaiters(next);
      for (const watcher of watchers.values()) {
        if (watcher.timer !== undefined) cancel(watcher.timer);
        watcher.timer = undefined;
        if (watcher.delegatedId !== undefined) {
          originalClearWatch.call(geolocation, watcher.delegatedId);
          watcher.delegatedId = undefined;
        }
        deliverPosition(watcher.success, next);
      }
    },

    hold(): void {
      allowNative = false;
      failImmediately = false;
      const current = position;
      if (current === null) return;
      flushWaiters(current);
      for (const watcher of watchers.values()) {
        if (watcher.timer === undefined) continue;
        cancel(watcher.timer);
        watcher.timer = undefined;
        deliverPosition(watcher.success, current);
      }
    },

    unavailable(): void {
      position = null;
      allowNative = false;
      failImmediately = true;
      rejectWaiters(POSITION_UNAVAILABLE, "No network identity location is available.");
      for (const watcher of watchers.values()) {
        if (watcher.timer !== undefined) cancel(watcher.timer);
        watcher.timer = undefined;
        if (watcher.delegatedId !== undefined) {
          originalClearWatch.call(geolocation, watcher.delegatedId);
          watcher.delegatedId = undefined;
        }
        deliverError(
          watcher.error,
          POSITION_UNAVAILABLE,
          "No network identity location is available.",
        );
      }
    },

    release(): void {
      position = null;
      allowNative = true;
      failImmediately = false;
      for (const waiter of [...waiters]) {
        if (waiter.timer !== undefined) cancel(waiter.timer);
        waiters.delete(waiter);
        delegateWaiter(waiter);
      }
      for (const watcher of watchers.values()) {
        if (watcher.timer !== undefined) cancel(watcher.timer);
        watcher.timer = undefined;
        delegateWatcher(watcher);
      }
    },

    getTarget(): GeoTarget | null {
      return position;
    },

    uninstall(): void {
      for (const waiter of [...waiters]) {
        if (waiter.timer !== undefined) cancel(waiter.timer);
        waiters.delete(waiter);
      }
      for (const [id, watcher] of [...watchers]) {
        if (watcher.timer !== undefined) cancel(watcher.timer);
        if (watcher.delegatedId !== undefined) {
          originalClearWatch.call(geolocation, watcher.delegatedId);
        }
        watchers.delete(id);
      }
      position = null;
      allowNative = false;
      failImmediately = false;
      proto.getCurrentPosition = originalGetCurrentPosition;
      proto.watchPosition = originalWatchPosition;
      proto.clearWatch = originalClearWatch;
      if (
        permissionsPrototype !== undefined &&
        permissionsPrototype !== null &&
        originalQuery !== undefined
      ) {
        permissionsPrototype.query = originalQuery;
      }
    },
  };
}
