/**
 * Page-level Geolocation shim (MAIN world).
 *
 * Overrides `navigator.geolocation.getCurrentPosition`, `watchPosition` and
 * `clearWatch` so that pages see the identity of the active profile.
 *
 * Semantics preserved as closely as practical:
 *   - callbacks are always invoked asynchronously, never synchronously
 *   - `watchPosition` returns an opaque numeric id accepted by `clearWatch`
 *   - the returned object is a real `GeolocationPosition` prototype instance with
 *     own `coords`/`timestamp` properties, so `instanceof` and property access work
 *   - while no identity is active, every call is delegated to the native
 *     implementation (the extension is invisible when idle)
 *   - while an identity is being resolved, requests are held for a bounded time
 *     instead of leaking the machine's real position
 *
 * `navigator.permissions.query({ name: "geolocation" })` is intentionally NOT
 * patched: see docs/ROADMAP.md.
 */
import { CONTENT_IDENTITY_WAIT_MS } from "../shared/constants";

export interface GeoTarget {
  latitude: number;
  longitude: number;
  accuracy: number;
}

/** PositionError constants, mirrored so the shim never depends on globals. */
export const POSITION_UNAVAILABLE = 2;

export interface PositionFactories {
  /** Only `prototype` is needed: Firefox exposes no constructor for these types. */
  positionCtor: { prototype: object } | undefined;
  coordinatesCtor: { prototype: object } | undefined;
  errorCtor: { prototype: object } | undefined;
  now: () => number;
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
 * This is the single assertion in the content scripts, and it is never applied to
 * untrusted input.
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
  defineValues(error, { code, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
  return error as GeolocationPositionError;
}

export interface GeolocationShim {
  readonly installed: boolean;
  /**
   * Applies a new target. `pending` means "an identity is being resolved": page
   * requests are briefly buffered instead of falling back to the real position.
   */
  setTarget(target: GeoTarget | null, pending: boolean): void;
  getTarget(): GeoTarget | null;
  uninstall(): void;
}

interface Waiter {
  success: PositionCallback | undefined;
  error: PositionErrorCallback | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  options: PositionOptions | undefined;
}

interface Watcher {
  success: PositionCallback | undefined;
  error: PositionErrorCallback | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  options: PositionOptions | undefined;
  /** Native watch id, set when a buffered watch timed out and was delegated. */
  delegatedId: number | undefined;
}

function noopShim(): GeolocationShim {
  return {
    installed: false,
    setTarget() {
      // No geolocation API in this context (for example a sandboxed frame).
    },
    getTarget() {
      return null;
    },
    uninstall() {
      // Nothing was patched.
    },
  };
}

export function installGeolocationShim(): GeolocationShim {
  const geolocation = typeof navigator === "undefined" ? undefined : navigator.geolocation;
  if (geolocation === undefined || geolocation === null) return noopShim();

  const proto = Object.getPrototypeOf(geolocation) as Geolocation;
  // The shim deliberately keeps unbound references so it can re-apply the native
  // implementation to whichever receiver a page used.
  /* eslint-disable @typescript-eslint/unbound-method */
  const originalGetCurrentPosition = proto.getCurrentPosition;
  const originalWatchPosition = proto.watchPosition;
  const originalClearWatch = proto.clearWatch;
  /* eslint-enable @typescript-eslint/unbound-method */

  const factories: PositionFactories = {
    positionCtor: typeof GeolocationPosition === "undefined" ? undefined : GeolocationPosition,
    coordinatesCtor:
      typeof GeolocationCoordinates === "undefined" ? undefined : GeolocationCoordinates,
    errorCtor:
      typeof GeolocationPositionError === "undefined" ? undefined : GeolocationPositionError,
    now: () => Date.now(),
  };

  let target: GeoTarget | null = null;
  let identityPending = false;
  let nextWatchId = 1_000_000;
  const waiters = new Set<Waiter>();
  const watchers = new Map<number, Watcher>();

  /** Used when a page omitted the success callback: nothing observable happens. */
  const noopPosition: PositionCallback = () => undefined;

  /** Async delivery, matching the native contract. */
  function deliverPosition(success: PositionCallback | undefined, current: GeoTarget): void {
    if (success === undefined) return;
    setTimeout(() => {
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
    setTimeout(() => {
      try {
        error(createErrorLike(code, message, factories));
      } catch {
        // Ignore page callback failures.
      }
    }, 0);
  }

  function patchedGetCurrentPosition(
    this: Geolocation,
    successCallback?: PositionCallback | null,
    errorCallback?: PositionErrorCallback | null,
    options?: PositionOptions,
  ): void {
    const current = target;
    if (current !== null) {
      deliverPosition(successCallback ?? undefined, current);
      return;
    }
    if (!identityPending) {
      originalGetCurrentPosition.call(
        this,
        successCallback ?? noopPosition,
        errorCallback ?? null,
        options,
      );
      return;
    }

    const waiter: Waiter = {
      success: successCallback ?? undefined,
      error: errorCallback ?? undefined,
      timer: undefined,
      options,
    };
    waiter.timer = setTimeout(() => {
      waiters.delete(waiter);
      // The identity never arrived: fall back to the native implementation.
      originalGetCurrentPosition.call(
        this,
        waiter.success ?? noopPosition,
        waiter.error ?? null,
        waiter.options,
      );
    }, CONTENT_IDENTITY_WAIT_MS);
    waiters.add(waiter);
  }

  function patchedWatchPosition(
    this: Geolocation,
    successCallback?: PositionCallback | null,
    errorCallback?: PositionErrorCallback | null,
    options?: PositionOptions,
  ): number {
    const current = target;
    const watchId = nextWatchId;
    nextWatchId += 1;

    if (current !== null) {
      watchers.set(watchId, {
        success: successCallback ?? undefined,
        error: errorCallback ?? undefined,
        timer: undefined,
        options,
        delegatedId: undefined,
      });
      deliverPosition(successCallback ?? undefined, current);
      return watchId;
    }

    if (!identityPending) {
      return originalWatchPosition.call(
        this,
        successCallback ?? noopPosition,
        errorCallback ?? null,
        options,
      );
    }

    const watcher: Watcher = {
      success: successCallback ?? undefined,
      error: errorCallback ?? undefined,
      timer: undefined,
      options,
      delegatedId: undefined,
    };
    watcher.timer = setTimeout(() => {
      const nativeId = originalWatchPosition.call(
        this,
        watcher.success ?? noopPosition,
        watcher.error ?? null,
        watcher.options,
      );
      watcher.delegatedId = nativeId;
      watcher.timer = undefined;
    }, CONTENT_IDENTITY_WAIT_MS);
    watchers.set(watchId, watcher);
    return watchId;
  }

  function patchedClearWatch(this: Geolocation, watchId?: number): void {
    if (typeof watchId !== "number") return;

    const watcher = watchers.get(watchId);
    if (watcher !== undefined) {
      if (watcher.timer !== undefined) clearTimeout(watcher.timer);
      if (watcher.delegatedId !== undefined) originalClearWatch.call(this, watcher.delegatedId);
      watchers.delete(watchId);
      return;
    }
    originalClearWatch.call(this, watchId);
  }

  proto.getCurrentPosition = patchedGetCurrentPosition;
  proto.watchPosition = patchedWatchPosition;
  proto.clearWatch = patchedClearWatch;

  return {
    installed: true,

    setTarget(next: GeoTarget | null, pending: boolean): void {
      target = next;
      identityPending = pending;

      if (next === null) {
        // Without an identity there is nothing left to deliver. Buffered or active
        // spoofed requests are settled honestly instead of hanging forever.
        for (const waiter of [...waiters]) {
          if (waiter.timer !== undefined) clearTimeout(waiter.timer);
          waiters.delete(waiter);
          deliverError(waiter.error, POSITION_UNAVAILABLE, "No network identity is active.");
        }
        for (const [id, watcher] of [...watchers]) {
          if (watcher.timer !== undefined) clearTimeout(watcher.timer);
          watchers.delete(id);
          if (watcher.delegatedId !== undefined) {
            originalClearWatch.call(geolocation, watcher.delegatedId);
          } else {
            deliverError(watcher.error, POSITION_UNAVAILABLE, "No network identity is active.");
          }
        }
        return;
      }

      for (const waiter of [...waiters]) {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        waiters.delete(waiter);
        deliverPosition(waiter.success, next);
      }
      for (const watcher of watchers.values()) {
        if (watcher.delegatedId === undefined) deliverPosition(watcher.success, next);
      }
    },

    getTarget(): GeoTarget | null {
      return target;
    },

    uninstall(): void {
      for (const waiter of [...waiters]) {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        waiters.delete(waiter);
      }
      for (const [id, watcher] of [...watchers]) {
        if (watcher.timer !== undefined) clearTimeout(watcher.timer);
        watchers.delete(id);
        if (watcher.delegatedId !== undefined)
          originalClearWatch.call(geolocation, watcher.delegatedId);
      }
      target = null;
      identityPending = false;
      proto.getCurrentPosition = originalGetCurrentPosition;
      proto.watchPosition = originalWatchPosition;
      proto.clearWatch = originalClearWatch;
    },
  };
}
