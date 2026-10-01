import { describe, expect, it, vi } from "vitest";
import { MapResourceBroker } from "../src/background/map-broker";
import type { DataCollectionSnapshot } from "../src/background/consent";
import type { ActiveProxyTarget } from "../src/background/proxy";
import {
  MAP_STYLE_URL,
  MAX_MAP_RESOURCE_BYTES,
  type MapResponse,
} from "../src/shared/map-provider";
import { createInitialRuntimeState } from "../src/shared/state";
import { createDeferred, createHarness, makeProfile, waitUntil } from "./helpers";

function harness() {
  const state = createInitialRuntimeState(0);
  Object.assign(state, { generation: 1, appliedRoute: "off", desiredRoute: "off" });
  let generation = 1;
  let target: ActiveProxyTarget | null = null;
  let sequence = 0;
  const collection = vi.fn(async (): Promise<DataCollectionSnapshot> => ({
    apiAvailable: true,
    optionalGranted: ["personallyIdentifyingInfo"],
  }));
  const fetcher = vi.fn<typeof fetch>(async () => new Response('{"version":8}', { status: 200 }));
  const broker = new MapResourceBroker({
    state: () => state,
    generation: () => generation,
    target: () => target,
    collection,
    fetch: fetcher,
    newId: () => `session-${++sequence}`,
  });
  return {
    state,
    broker,
    collection,
    fetcher,
    advance: () => {
      generation += 1;
    },
    proxy: (bypassHosts: string[] = []) => {
      Object.assign(state, { appliedRoute: "proxy", desiredRoute: "proxy", status: "ready" });
      target = {
        profileId: "p",
        profileName: "Proxy",
        generation,
        credentials: null,
        proxy: { type: "socks5", host: "proxy.example", port: 1080, proxyDNS: true, bypassHosts },
      };
      return target;
    },
  };
}
function sessionId(response: MapResponse): string {
  if (!response.ok || response.sessionId === undefined) throw new Error("Session did not open");
  return response.sessionId;
}
const fetchRequest = (id: string, requestId = "request-1") => ({
  type: "map:fetch" as const,
  sessionId: id,
  requestId,
  url: MAP_STYLE_URL,
});

describe("map data broker", () => {
  it("is silent until explicit enable and applies the complete privacy request contract", async () => {
    const h = harness();
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.broker.allowsNetwork(MAP_STYLE_URL)).toBe(false);
    const id = sessionId(await h.broker.handle({ type: "map:open", generation: 1 }, "owner"));
    expect(h.fetcher).not.toHaveBeenCalled();
    const response = await h.broker.handle(fetchRequest(id), "owner");
    expect(response.ok).toBe(true);
    expect(h.fetcher).toHaveBeenCalledWith(
      MAP_STYLE_URL,
      expect.objectContaining({
        method: "GET",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        cache: "no-store",
      }),
    );
    expect(h.broker.allowsNetwork(MAP_STYLE_URL)).toBe(false);
  });
  it("requires API availability for proxy and optional public-IP consent for Direct/Off", async () => {
    const h = harness();
    h.collection.mockResolvedValue({ apiAvailable: true, optionalGranted: [] });
    expect((await h.broker.handle({ type: "map:open", generation: 1 }, "owner")).ok).toBe(false);
    h.proxy();
    expect((await h.broker.handle({ type: "map:open", generation: 1 }, "owner")).ok).toBe(true);
    h.collection.mockResolvedValue({ apiAvailable: false, optionalGranted: [] });
    expect((await h.broker.handle({ type: "map:open", generation: 1 }, "owner")).ok).toBe(false);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("refuses proxy bypass, missing credentials, blocked/cold routes and obsolete generations", async () => {
    for (const reason of ["bypass", "credentials", "blocked", "cold", "generation"]) {
      const h = harness();
      const target = h.proxy(reason === "bypass" ? ["openfreemap.org"] : []);
      if (reason === "credentials") target.proxy.authenticationRequired = true;
      if (reason === "blocked") h.state.appliedRoute = "blocked";
      if (reason === "cold") h.state.appliedRoute = "restoring";
      if (reason === "generation") h.advance();
      expect((await h.broker.handle({ type: "map:open", generation: 1 }, "owner")).ok, reason).toBe(
        false,
      );
      expect(h.fetcher).not.toHaveBeenCalled();
    }
  });
  it("does not recreate consent after revoke/invalidate during the awaited grant", async () => {
    const h = harness();
    const grant = createDeferred<DataCollectionSnapshot>();
    h.collection.mockReturnValue(grant.promise);
    const result = h.broker.handle({ type: "map:open", generation: 1 }, "owner");
    h.broker.invalidate();
    grant.resolve({ apiAvailable: true, optionalGranted: ["personallyIdentifyingInfo"] });
    expect((await result).ok).toBe(false);
  });
  it("binds tokens to their options owner and rechecks consent before every fetch", async () => {
    const h = harness();
    const id = sessionId(await h.broker.handle({ type: "map:open", generation: 1 }, "owner"));
    expect((await h.broker.handle(fetchRequest(id), "other")).ok).toBe(false);
    h.collection.mockResolvedValue({ apiAvailable: true, optionalGranted: [] });
    expect((await h.broker.handle(fetchRequest(id), "owner")).ok).toBe(false);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("aborts pending fetches synchronously before a route transition or owner close", async () => {
    for (const action of ["invalidate", "owner", "cancel"]) {
      const h = harness();
      const id = sessionId(await h.broker.handle({ type: "map:open", generation: 1 }, "owner"));
      let signal: AbortSignal | null | undefined;
      h.fetcher.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            signal = init?.signal;
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      );
      const result = h.broker.handle(fetchRequest(id), "owner");
      await waitUntil(() => h.fetcher.mock.calls.length === 1);
      expect(h.broker.allowsNetwork(MAP_STYLE_URL)).toBe(true);
      if (action === "invalidate") {
        h.broker.invalidate();
        h.advance();
      } else if (action === "owner") h.broker.closeOwner("owner");
      else
        await h.broker.handle(
          { type: "map:cancel", sessionId: id, requestId: "request-1" },
          "owner",
        );
      expect(signal?.aborted).toBe(true);
      expect(h.broker.allowsNetwork(MAP_STYLE_URL)).toBe(false);
      expect((await result).ok).toBe(false);
    }
  });
  it("bounds response bytes even without content-length and never follows redirects", async () => {
    const h = harness();
    const id = sessionId(await h.broker.handle({ type: "map:open", generation: 1 }, "owner"));
    h.fetcher.mockResolvedValue(new Response(new Uint8Array(MAX_MAP_RESOURCE_BYTES + 1)));
    expect((await h.broker.handle(fetchRequest(id), "owner")).ok).toBe(false);
    h.fetcher.mockResolvedValue(
      new Response("", { status: 302, headers: { location: "https://evil.example" } }),
    );
    expect((await h.broker.handle(fetchRequest(id), "owner")).ok).toBe(false);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });
  it("queues at most 64 requests globally, runs eight at a time and cancels queued work", async () => {
    const h = harness();
    const ids = [];
    for (let i = 0; i < 4; i++)
      ids.push(sessionId(await h.broker.handle({ type: "map:open", generation: 1 }, "owner")));
    expect((await h.broker.handle({ type: "map:open", generation: 1 }, "owner")).ok).toBe(false);
    h.fetcher.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const pending: Array<Promise<MapResponse>> = [];
    for (let i = 0; i < 64; i++)
      pending.push(h.broker.handle(fetchRequest(ids[Math.floor(i / 32)] ?? "", `r-${i}`), "owner"));
    await waitUntil(() => h.fetcher.mock.calls.length === 8);
    expect((await h.broker.handle(fetchRequest(ids[2] ?? "", "overflow"), "owner")).ok).toBe(false);
    h.broker.invalidate();
    expect((await Promise.all(pending)).every((response) => !response.ok)).toBe(true);
    expect(h.fetcher).toHaveBeenCalledTimes(8);
  });
  it("a new background broker cannot reuse an old session", async () => {
    const before = harness();
    const id = sessionId(await before.broker.handle({ type: "map:open", generation: 1 }, "owner"));
    const after = harness();
    expect((await after.broker.handle(fetchRequest(id), "owner")).ok).toBe(false);
    expect(after.fetcher).not.toHaveBeenCalled();
  });
  it("expires requests after 20 seconds without retry or direct fallback", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const id = sessionId(await h.broker.handle({ type: "map:open", generation: 1 }, "owner"));
      h.fetcher.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      );
      const result = h.broker.handle(fetchRequest(id), "owner");
      await vi.advanceTimersByTimeAsync(20_000);
      expect((await result).ok).toBe(false);
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("cancels before the controller changes its generation or routing target", async () => {
    const h = createHarness();
    const seen: Array<{ generation: number; target: string | null }> = [];
    h.deps.beforeRouteChange = () =>
      seen.push({
        generation: h.controller.getGeneration(),
        target: h.controller.getTarget()?.profileId ?? null,
      });
    await h.controller.initialize();
    expect(seen).toEqual([{ generation: 0, target: null }]);
    const profile = makeProfile({ id: "map-route-test" });
    await h.saveProfile(profile);
    await h.controller.activate(profile.id);
    expect(seen[1]).toEqual({ generation: 0, target: null });
    const generation = h.controller.getGeneration();
    await h.controller.deactivate();
    expect(seen[2]).toEqual({ generation, target: profile.id });
  });
  it("does not create an orphan session after its owner navigates or closes", async () => {
    const h = harness();
    const grant = createDeferred<DataCollectionSnapshot>();
    h.collection.mockReturnValue(grant.promise);
    const result = h.broker.handle({ type: "map:open", generation: 1 }, "owner");
    h.broker.closeOwner("owner");
    grant.resolve({ apiAvailable: true, optionalGranted: ["personallyIdentifyingInfo"] });
    expect((await result).ok).toBe(false);
  });
  it("the resource timeout settles even while the permission read is stuck", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const id = sessionId(await h.broker.handle({ type: "map:open", generation: 1 }, "owner"));
      h.collection.mockReturnValue(new Promise(() => {}));
      const result = h.broker.handle(fetchRequest(id), "owner");
      await vi.advanceTimersByTimeAsync(20_000);
      expect((await result).ok).toBe(false);
      expect(h.fetcher).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("enforces the aggregate 16 MiB streaming budget and releases it after cancellation", async () => {
    const h = harness();
    const id = sessionId(await h.broker.handle({ type: "map:open", generation: 1 }, "owner"));
    h.fetcher.mockImplementation((_url, init) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_MAP_RESOURCE_BYTES));
              init?.signal?.addEventListener(
                "abort",
                () => controller.error(new Error("aborted")),
                { once: true },
              );
            },
          }),
        ),
      ),
    );
    const pending = Array.from({ length: 5 }, (_, index) =>
      h.broker.handle(fetchRequest(id, `budget-${index}`), "owner"),
    );
    const overBudget = await Promise.race(pending);
    expect(overBudget).toMatchObject({
      ok: false,
      error: "Map resource stopped or exceeds the size limit.",
    });
    h.broker.invalidate();
    expect((await Promise.all(pending)).every((response) => !response.ok)).toBe(true);
    h.fetcher.mockResolvedValue(new Response("{}"));
    const next = sessionId(await h.broker.handle({ type: "map:open", generation: 1 }, "owner"));
    expect((await h.broker.handle(fetchRequest(next), "owner")).ok).toBe(true);
  });
});
