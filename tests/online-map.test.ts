import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOnlineMap } from "../src/options/online-map";
import { createDeferred } from "./helpers";

type Protocol = (
  parameters: { url: string; type?: string },
  controller: AbortController,
) => Promise<unknown>;
const mocks = vi.hoisted(() => ({
  protocol: undefined as Protocol | undefined,
  transform: undefined as ((url: string) => { url: string }) | undefined,
  handlers: new Map<string, () => void>(),
  canvas: { addEventListener: vi.fn(), setAttribute: vi.fn(), tabIndex: 0 },
}));
vi.mock("maplibre-gl", () => ({
  Map: class {
    constructor(options: { transformRequest: (url: string) => { url: string } }) {
      mocks.transform = options.transformRequest;
    }
    on(event: string, handler: () => void) {
      mocks.handlers.set(event, handler);
    }
    getCanvas() {
      return mocks.canvas;
    }
    resize() {}
    jumpTo() {}
    remove() {}
  },
  addProtocol: (_name: string, protocol: Protocol) => {
    mocks.protocol = protocol;
  },
  removeProtocol: vi.fn(),
  setWorkerUrl: vi.fn(),
}));

const message = vi.fn<(message: unknown) => Promise<unknown>>();
const data = (text: string) => new TextEncoder().encode(text).buffer;
const viewport = { width: 600, height: 280, zoom: 2, center: { latitude: 0, longitude: 0 } };
const glyph = "ni-map-fixture://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/25856-26111.pbf";
const setup = () => {
  const onError = vi.fn<(fatal: boolean) => void>();
  const onReady = vi.fn();
  // Only replaceChildren is used on this host; MapLibre itself is an injected double.
  const container = { replaceChildren: vi.fn() } as unknown as HTMLElement;
  const map = createOnlineMap(container, "fixture", viewport, onError, onReady);
  const protocol = mocks.protocol;
  if (!protocol) throw new Error("Protocol was not registered");
  return { map, protocol, onError, onReady };
};

beforeEach(() => {
  mocks.handlers.clear();
  message.mockReset().mockResolvedValue({ ok: true, data: data("{}") });
  vi.stubGlobal("browser", {
    runtime: { sendMessage: message, getURL: (path: string) => `moz-extension://fixture/${path}` },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("online map protocol failure reporting", () => {
  it("reports a swallowed initial glyph failure and never overwrites it with ready", async () => {
    message.mockResolvedValue({ ok: false, error: "unavailable", kind: "unavailable" });
    const { map, protocol, onError, onReady } = setup();
    await expect(protocol({ url: glyph }, new AbortController())).rejects.toThrow();
    expect(onError).toHaveBeenCalledWith(true);
    mocks.handlers.get("load")?.();
    expect(onReady).not.toHaveBeenCalled();
    map.remove();
  });

  it("keeps loaded geography incomplete after a glyph failure until explicit reload", async () => {
    const { map, protocol, onError, onReady } = setup();
    mocks.handlers.get("load")?.();
    expect(onReady).toHaveBeenCalledTimes(1);
    message.mockResolvedValue({ ok: false, error: "unavailable", kind: "unavailable" });
    await expect(protocol({ url: glyph }, new AbortController())).rejects.toThrow();
    expect(onError).toHaveBeenCalledWith(false);
    mocks.handlers.get("load")?.();
    expect(onReady).toHaveBeenCalledTimes(1);
    map.remove();
  });

  it("treats blocked/invalid data as fatal and catches malformed JSON", async () => {
    const { map, protocol, onError } = setup();
    mocks.handlers.get("load")?.();
    message.mockResolvedValue({ ok: false, error: "expired", kind: "blocked" });
    await expect(protocol({ url: glyph }, new AbortController())).rejects.toThrow();
    expect(onError).toHaveBeenLastCalledWith(true);
    message.mockResolvedValue({ ok: true, data: data("not JSON") });
    await expect(
      protocol(
        { url: "ni-map-fixture://tiles.openfreemap.org/styles/liberty", type: "json" },
        new AbortController(),
      ),
    ).rejects.toThrow();
    expect(onError).toHaveBeenLastCalledWith(false);
    await expect(
      protocol({ url: "https://unapproved.example/style" }, new AbortController()),
    ).rejects.toThrow();
    expect(onError).toHaveBeenLastCalledWith(true);
    map.remove();
  });

  it("reports blocked style resource URLs even before the custom protocol runs", () => {
    const { map, onError, onReady } = setup();
    expect(() => mocks.transform?.("https://unapproved.example/font.pbf")).toThrow("Unapproved");
    expect(onError).toHaveBeenCalledWith(true);
    mocks.handlers.get("load")?.();
    expect(onReady).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
    map.remove();
  });

  it("cancels active broker work without reporting an ordinary abort as a map failure", async () => {
    const gate = createDeferred<unknown>();
    message.mockImplementation(async (request) => {
      if (
        typeof request === "object" &&
        request !== null &&
        "type" in request &&
        request.type === "map:fetch"
      )
        return gate.promise;
      return { ok: true };
    });
    const { map, protocol, onError } = setup();
    const abort = new AbortController();
    const result = protocol({ url: glyph }, abort).catch((error: unknown) => error);
    await Promise.resolve();
    abort.abort();
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(message).toHaveBeenCalledWith(expect.objectContaining({ type: "map:cancel" }));
    expect(onError).not.toHaveBeenCalled();
    gate.resolve({ ok: true, data: data("{}") });
    map.remove();
  });

  it("dispatches nothing after removal invalidates queued and not-yet-started work", async () => {
    const { map, protocol, onError } = setup();
    const results = Array.from({ length: 100 }, () =>
      protocol({ url: glyph }, new AbortController()).catch((error: unknown) => error),
    );
    map.remove();
    await Promise.all(results);
    expect(message).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
