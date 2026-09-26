import { describe, expect, it } from "vitest";
import {
  POSITION_TIMEOUT,
  POSITION_UNAVAILABLE,
  geolocationCommandForEnvelope,
  installGeolocationShim,
  type GeoTarget,
} from "../src/content/geolocation-shim";
import { createIdentityEnvelope, createPublicIdentity } from "../src/shared/public-identity";

const AMSTERDAM: GeoTarget = { latitude: 52.37, longitude: 4.89, accuracy: 20000 };
const BERLIN: GeoTarget = { latitude: 52.52, longitude: 13.4, accuracy: 20000 };

interface NativeCalls {
  get: number;
  watch: number;
  clear: number;
}

interface Clock {
  advance(ms: number): void;
}

function installFake() {
  const calls: NativeCalls = { get: 0, watch: 0, clear: 0 };
  const proto = {
    getCurrentPosition(_success: PositionCallback, error?: PositionErrorCallback | null): void {
      calls.get += 1;
      error?.({
        code: 1,
        message: "native",
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      });
    },
    watchPosition(): number {
      calls.watch += 1;
      return 7;
    },
    clearWatch(): void {
      calls.clear += 1;
    },
  };
  const geolocation = Object.create(proto) as Geolocation;
  const permissionCalls = { query: 0 };
  const permissionsProto = {
    query(descriptor: PermissionDescriptor): Promise<PermissionStatus> {
      permissionCalls.query += 1;
      return Promise.resolve({ state: "prompt", name: descriptor.name } as PermissionStatus);
    },
  };
  const permissions = Object.create(permissionsProto) as Permissions;

  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: Clock = {
    advance(ms: number): void {
      now += ms;
      let progressed = true;
      while (progressed) {
        progressed = false;
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((left, right) => left[1].at - right[1].at);
        for (const [id, timer] of due) {
          if (!timers.has(id)) continue;
          timers.delete(id);
          timer.callback();
          progressed = true;
        }
      }
    },
  };

  const shim = installGeolocationShim({
    geolocation,
    permissions,
    now: () => 1_700_000_000_000,
    schedule(callback, delayMs) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    cancel(handle) {
      timers.delete(handle);
    },
  });

  return { shim, calls, clock, geolocation, permissions, permissionCalls };
}

function requestPosition(
  geolocation: Geolocation,
  options?: PositionOptions,
): Promise<{ latitude?: number; code?: number; message?: string }> {
  return new Promise((resolve) => {
    geolocation.getCurrentPosition(
      (position) => resolve({ latitude: position.coords.latitude }),
      (error) => resolve({ code: error.code, message: error.message }),
      options,
    );
  });
}

describe("geolocationCommandForEnvelope", () => {
  it("uses coordinates whenever they are present", () => {
    const payload = createPublicIdentity({
      generation: 2,
      latitude: 1,
      longitude: 2,
      accuracy: 20,
      timezone: "UTC",
    });
    expect(geolocationCommandForEnvelope(createIdentityEnvelope(payload, true, true))).toEqual({
      type: "position",
      target: { latitude: 1, longitude: 2, accuracy: 20 },
    });
  });

  it("holds while pending and fails closed when a controlled identity has no position", () => {
    expect(geolocationCommandForEnvelope(createIdentityEnvelope(null, true, true))).toEqual({
      type: "hold",
    });
    expect(geolocationCommandForEnvelope(createIdentityEnvelope(null, false, true))).toEqual({
      type: "unavailable",
    });
    expect(geolocationCommandForEnvelope(createIdentityEnvelope(null, false, false))).toEqual({
      type: "release",
    });
  });
});

describe("installGeolocationShim", () => {
  it("does not call native geolocation before the extension says it is idle", async () => {
    const { shim, calls, clock, geolocation } = installFake();
    let settled = false;
    const pending = requestPosition(geolocation).then((value) => {
      settled = true;
      return value;
    });
    clock.advance(0);
    expect(calls.get).toBe(0);

    // A full provider timeout must not expire the hold or touch native geolocation.
    clock.advance(8000);
    expect(settled).toBe(false);
    expect(calls.get).toBe(0);

    clock.advance(2000);
    await Promise.resolve();
    expect(calls.get).toBe(0);
    await expect(pending).resolves.toMatchObject({ code: POSITION_TIMEOUT });
    shim.uninstall();
  });

  it("serves a synthetic position and keeps it across a pending refresh", async () => {
    const { shim, calls, clock, geolocation } = installFake();
    shim.setPosition(AMSTERDAM);
    const first = requestPosition(geolocation);
    clock.advance(0);
    await expect(first).resolves.toMatchObject({ latitude: AMSTERDAM.latitude });

    shim.hold();
    const during = requestPosition(geolocation);
    clock.advance(5000);
    await expect(during).resolves.toMatchObject({ latitude: AMSTERDAM.latitude });
    expect(calls.get).toBe(0);
    expect(shim.getTarget()).toEqual(AMSTERDAM);
    shim.uninstall();
  });

  it("flushes a held request with the committed position and never calls native", async () => {
    const { shim, calls, clock, geolocation } = installFake();
    shim.hold();
    const pending = requestPosition(geolocation, { enableHighAccuracy: true, timeout: 10_000 });
    clock.advance(1000);
    expect(calls.get).toBe(0);

    shim.setPosition(BERLIN);
    clock.advance(0);
    await expect(pending).resolves.toMatchObject({ latitude: BERLIN.latitude });
    expect(calls.get).toBe(0);
    shim.uninstall();
  });

  it("returns unavailable when the active profile has no coordinates", async () => {
    const { shim, calls, clock, geolocation } = installFake();
    shim.setPosition(AMSTERDAM);
    shim.unavailable();
    const failed = requestPosition(geolocation);
    clock.advance(0);
    await expect(failed).resolves.toMatchObject({ code: POSITION_UNAVAILABLE });
    expect(calls.get).toBe(0);
    expect(shim.getTarget()).toBeNull();

    const again = requestPosition(geolocation, { enableHighAccuracy: true });
    clock.advance(10_000);
    await expect(again).resolves.toMatchObject({ code: POSITION_UNAVAILABLE });
    expect(calls.get).toBe(0);
    shim.uninstall();
  });

  it("uses native geolocation only after release", async () => {
    const { shim, calls, clock, geolocation } = installFake();
    shim.hold();
    const waiting = requestPosition(geolocation);
    shim.release();
    clock.advance(0);
    await waiting;
    expect(calls.get).toBe(1);

    await requestPosition(geolocation);
    expect(calls.get).toBe(2);

    const watchId = geolocation.watchPosition(() => undefined);
    expect(calls.watch).toBe(1);
    geolocation.clearWatch(watchId);
    expect(calls.clear).toBe(1);
    shim.uninstall();
  });

  it("does not delegate a watch to native while identity is pending or failed", () => {
    const { shim, calls, clock, geolocation } = installFake();
    const watchId = geolocation.watchPosition(
      () => undefined,
      () => undefined,
    );
    clock.advance(10_000);
    expect(calls.watch).toBe(0);

    shim.unavailable();
    clock.advance(0);
    expect(calls.watch).toBe(0);

    geolocation.clearWatch(watchId);
    expect(calls.clear).toBe(0);
    shim.setPosition(BERLIN);
    expect(calls.get).toBe(0);
    expect(calls.watch).toBe(0);
    shim.uninstall();
  });

  it("reports geolocation permission as granted while identity is controlled", async () => {
    const { shim, permissions, permissionCalls } = installFake();
    const held = await permissions.query({ name: "geolocation" });
    expect(held.state).toBe("granted");
    expect(permissionCalls.query).toBe(0);

    shim.setPosition(AMSTERDAM);
    expect((await permissions.query({ name: "geolocation" })).state).toBe("granted");

    shim.unavailable();
    expect((await permissions.query({ name: "geolocation" })).state).toBe("granted");

    const other = await permissions.query({ name: "notifications" });
    expect(other.state).toBe("prompt");
    expect(permissionCalls.query).toBe(1);

    shim.release();
    expect((await permissions.query({ name: "geolocation" })).state).toBe("prompt");
    expect(permissionCalls.query).toBe(2);
    shim.uninstall();
  });
});
