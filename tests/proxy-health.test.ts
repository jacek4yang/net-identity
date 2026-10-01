import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProxyCooldown,
  ProxyHealthTracker,
  sanitizeProxyEndpoint,
} from "../src/background/proxy-health";

const endpoint = { type: "socks", host: "proxy.invalid", port: 1080 };
function setup() {
  let now = 0;
  let id = 0;
  const tracker = new ProxyHealthTracker(() => now);
  tracker.reset(1);
  return {
    tracker,
    advance: (ms: number) => {
      now += ms;
    },
    observe: (success = false, host = `origin${id % 2}.invalid`, extras = {}) => {
      const requestId = String(id++);
      const url = `https://${host}/`;
      tracker.track(requestId, 1, url, endpoint);
      tracker.observe(
        {
          requestId,
          url,
          proxyInfo: endpoint,
          fromCache: false,
          error: "NS_ERROR_NET_RESET",
          ...extras,
        },
        success,
      );
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("conservative proxy health", () => {
  it("sanitizes and validates endpoints without retaining secrets", () => {
    expect(
      sanitizeProxyEndpoint({
        ...endpoint,
        username: "private",
        password: "secret",
        proxyAuthorizationHeader: "secret",
      }),
    ).toEqual(endpoint);
    for (const value of [
      null,
      {},
      { ...endpoint, port: 0 },
      { ...endpoint, port: 1.5 },
      { ...endpoint, type: "direct" },
      { ...endpoint, host: "" },
    ])
      expect(sanitizeProxyEndpoint(value)).toBeNull();
  });

  it("does not classify burst, one-origin, cancelled, absent or mismatching route errors as unavailable", () => {
    const h = setup();
    for (let i = 0; i < 50; i++) h.observe();
    expect(h.tracker.status).toBe("healthy");
    h.advance(6000);
    for (let i = 0; i < 5; i++) {
      h.observe(false, "one.invalid");
      h.advance(400);
    }
    expect(h.tracker.status).toBe("healthy");
    for (const extras of [
      { error: "NS_BINDING_ABORTED" },
      { proxyInfo: undefined },
      { proxyInfo: { ...endpoint, port: 9999 } },
      { fromCache: true },
    ]) {
      for (let i = 0; i < 4; i++) {
        h.observe(false, undefined, extras);
        h.advance(400);
      }
    }
    expect(h.tracker.status).toBe("healthy");
    expect(h.tracker.cooldownMs()).toBe(0);
  });

  it("counts time buckets, bounds cooldown and never interprets generic error names as transport proof", () => {
    const h = setup();
    h.observe();
    h.advance(300);
    h.observe();
    h.advance(300);
    h.observe();
    expect(h.tracker.status).toBe("suspect");
    expect(h.tracker.cooldownMs()).toBe(250);
    for (const expected of [500, 1000, 2000, 2000]) {
      h.advance(300);
      h.observe();
      expect(h.tracker.cooldownMs()).toBe(expected);
      expect(h.tracker.status).not.toBe("unavailable");
    }
    h.advance(2001);
    expect(h.tracker.cooldownMs()).toBe(0);
  });

  it("requires sustained recovery and ignores cached success", () => {
    const h = setup();
    for (let i = 0; i < 3; i++) {
      h.observe();
      h.advance(300);
    }
    h.observe(true, undefined, { fromCache: true });
    expect(h.tracker.status).toBe("suspect");
    h.observe(true);
    expect(h.tracker.status).toBe("recovering");
    h.observe(true);
    expect(h.tracker.status).toBe("recovering");
    h.advance(1000);
    h.observe(true);
    expect(h.tracker.status).toBe("healthy");
    expect(h.tracker.cooldownMs()).toBe(0);
  });

  it("successful network traffic prevents accumulation of unrelated origin failures", () => {
    const h = setup();
    for (let i = 0; i < 10; i++) {
      h.observe();
      h.advance(350);
      h.observe(true);
    }
    expect(h.tracker.status).toBe("healthy");
  });

  it("expires samples and bounds retained request IDs", () => {
    const h = setup();
    for (let i = 0; i < 1000; i++)
      h.tracker.track(String(i), 1, "https://origin.invalid/", endpoint);
    expect(h.tracker.trackedRequestCount).toBe(512);
    h.advance(30001);
    h.observe();
    expect(h.tracker.trackedRequestCount).toBe(0);
    h.tracker.reset(2);
    h.tracker.track("old", 1, "https://origin.invalid/", endpoint);
    expect(h.tracker.trackedRequestCount).toBe(0);
  });
});

describe("shared bounded cooldown", () => {
  it("uses no healthy timer, shares a single timer and cancels promptly", async () => {
    vi.useFakeTimers();
    const gate = new ProxyCooldown();
    expect(gate.wait(0)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const pending = gate.wait(250);
    expect(gate.wait(2000)).toBe(pending);
    expect(vi.getTimerCount()).toBe(1);
    gate.cancel();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds waiting callers without blocking or changing overflow routing", async () => {
    vi.useFakeTimers();
    const gate = new ProxyCooldown();
    const pending = gate.wait(2000);
    for (let i = 1; i < 128; i++) expect(gate.wait(2000)).toBe(pending);
    expect(gate.wait(2000)).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    gate.cancel();
    await pending;
    const next = gate.wait(250);
    expect(next).not.toBeNull();
    gate.cancel();
    await next;
  });

  it("caps even oversized waits at two seconds", async () => {
    vi.useFakeTimers();
    const gate = new ProxyCooldown();
    const pending = gate.wait(99999);
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
});
