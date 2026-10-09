import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDirectIpConsent, readMapAutoload, writeMapAutoload } from "../src/shared/runtime";

afterEach(() => vi.unstubAllGlobals());

describe("explicit map auto-loading preference", () => {
  it.each([undefined, null, false, "true", 1, {}, true])(
    "requires literal saved opt-in %j",
    async (value) => {
      vi.stubGlobal("browser", {
        storage: { local: { get: vi.fn(async () => ({ "ni.map.autoload.v1": value })) } },
      });
      expect(await readMapAutoload()).toBe(value === true);
    },
  );
  it("stores only the boolean choice", async () => {
    const set = vi.fn(async () => undefined);
    vi.stubGlobal("browser", { storage: { local: { set } } });
    await writeMapAutoload(true);
    await writeMapAutoload(false);
    expect(set.mock.calls).toEqual([
      [{ "ni.map.autoload.v1": true }],
      [{ "ni.map.autoload.v1": false }],
    ]);
  });
  it.each([[], undefined])(
    "never prompts on an automatic direct load without a grant",
    async (data) => {
      const request = vi.fn(async () => true);
      vi.stubGlobal("browser", {
        permissions: { getAll: vi.fn(async () => ({ data_collection: data })), request },
      });
      expect(await ensureDirectIpConsent("direct", false)).toBe(false);
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("uses an existing direct grant without asking again", async () => {
    const request = vi.fn(async () => true);
    vi.stubGlobal("browser", {
      permissions: {
        getAll: vi.fn(async () => ({ data_collection: ["personallyIdentifyingInfo"] })),
        request,
      },
    });
    expect(await ensureDirectIpConsent("direct", false)).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
  it("still asks from an explicit load gesture", async () => {
    const request = vi.fn(async () => false);
    vi.stubGlobal("browser", {
      permissions: { getAll: vi.fn(async () => ({ data_collection: [] })), request },
    });
    expect(await ensureDirectIpConsent("direct")).toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });
});
