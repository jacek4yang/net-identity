import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  events: new Map<string, () => void>(),
  setStyle: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
  addProtocol: vi.fn(),
  removeProtocol: vi.fn(),
}));
vi.mock("maplibre-gl", () => ({
  Map: class {
    constructor() {
      fake.create();
    }
    on(event: string, callback: () => void) {
      fake.events.set(event, callback);
    }
    getCanvas() {
      return { addEventListener: vi.fn(), setAttribute: vi.fn(), tabIndex: 0 };
    }
    setStyle = fake.setStyle;
    remove = fake.remove;
    resize() {
      /* no graphics in a unit test */
    }
    jumpTo() {
      /* camera tested separately */
    }
  },
  addProtocol: fake.addProtocol,
  removeProtocol: fake.removeProtocol,
  setWorkerUrl: vi.fn(),
}));
vi.mock("../src/shared/runtime", () => ({
  extensionUrl: (path: string) => `moz-extension://fixture/${path}`,
  request: vi.fn(),
}));
import { createOnlineMap } from "../src/options/online-map";

beforeEach(() => {
  vi.clearAllMocks();
  fake.events.clear();
});
describe("online map reload ownership", () => {
  it("reloads data without recreating a WebGL context, then disposes exactly once", () => {
    const container = { replaceChildren: vi.fn() };
    const ready = vi.fn();
    const error = vi.fn();
    const map = createOnlineMap(
      container as unknown as HTMLElement,
      "session-fixture",
      {
        width: 300,
        height: 200,
        zoom: 2,
        center: { latitude: 0, longitude: 0 },
      },
      error,
      ready,
    );
    fake.events.get("idle")?.();
    expect(ready).toHaveBeenCalledTimes(1);
    fake.events.get("error")?.();
    expect(error).toHaveBeenCalledWith(false);
    for (let i = 0; i < 3; ++i) {
      map.reload();
      fake.events.get("idle")?.();
    }
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(fake.addProtocol).toHaveBeenCalledTimes(1);
    expect(fake.setStyle).toHaveBeenCalledTimes(3);
    expect(fake.remove).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledTimes(4);
    map.remove();
    map.remove();
    map.reload();
    expect(fake.remove).toHaveBeenCalledTimes(1);
    expect(fake.removeProtocol).toHaveBeenCalledTimes(1);
    expect(fake.setStyle).toHaveBeenCalledTimes(3);
  });
});
