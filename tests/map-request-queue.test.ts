import { afterEach, describe, expect, it, vi } from "vitest";
import { MAP_QUEUE_LIMITS, MapRequestQueue } from "../src/options/map-request-queue";
import { createDeferred } from "./helpers";

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const signal = () => new AbortController().signal;

afterEach(() => vi.useRealTimers());

describe("bounded renderer resource queue", () => {
  it("dispatches a 100-resource glyph burst in FIFO order with at most eight active RPCs", async () => {
    const queue = new MapRequestQueue();
    const gates = Array.from({ length: 100 }, () => createDeferred<number>());
    const started: number[] = [];
    let active = 0,
      peak = 0;
    const results = gates.map((gate, index) =>
      queue.run(signal(), async () => {
        started.push(index);
        peak = Math.max(peak, ++active);
        try {
          return await gate.promise;
        } finally {
          --active;
        }
      }),
    );
    await flush();
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    gates.forEach((gate, index) => gate.resolve(index));
    expect(await Promise.all(results)).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(started).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(peak).toBe(8);
    queue.dispose();
  });

  it("rejects overflow without dispatch and drains all queued state on disposal", async () => {
    const queue = new MapRequestQueue();
    const gate = createDeferred<void>();
    const task = vi.fn(() => gate.promise);
    const results = Array.from({ length: MAP_QUEUE_LIMITS.active + MAP_QUEUE_LIMITS.waiting }, () =>
      queue.run(signal(), task).catch((error: unknown) => error),
    );
    await expect(queue.run(signal(), task)).rejects.toThrow("queue is full");
    queue.dispose();
    expect(task).toHaveBeenCalledTimes(8);
    expect(
      (await Promise.all(results)).every(
        (error) => error instanceof DOMException && error.name === "AbortError",
      ),
    ).toBe(true);
    gate.resolve();
    await flush();
    await expect(queue.run(signal(), task)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("never dispatches a queued cancellation and holds an aborted active RPC slot until settlement", async () => {
    const queue = new MapRequestQueue();
    const gate = createDeferred<void>();
    const first = new AbortController();
    const activeSignals: AbortSignal[] = [];
    const task = vi.fn((current: AbortSignal) => {
      activeSignals.push(current);
      return gate.promise;
    });
    const results = Array.from({ length: 8 }, (_, i) =>
      queue.run(i === 0 ? first.signal : signal(), task).catch((e: unknown) => e),
    );
    const queued = new AbortController();
    const cancelled = queue.run(queued.signal, task).catch((e: unknown) => e);
    const last = queue.run(signal(), task);
    await flush();
    queued.abort();
    first.abort();
    expect(await cancelled).toMatchObject({ name: "AbortError" });
    await flush();
    expect(task).toHaveBeenCalledTimes(8);
    expect(activeSignals[0]?.aborted).toBe(true);
    gate.resolve();
    await Promise.all([...results, last]);
    expect(task).toHaveBeenCalledTimes(9);
    queue.dispose();
  });

  it("includes waiting time in its deadline and aborts active work without replay", async () => {
    vi.useFakeTimers();
    const queue = new MapRequestQueue();
    const gate = createDeferred<void>();
    const activeSignals: AbortSignal[] = [];
    const task = vi.fn((current: AbortSignal) => {
      activeSignals.push(current);
      return gate.promise;
    });
    const results = Array.from({ length: 9 }, () =>
      queue.run(signal(), task).catch((e: unknown) => e),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(MAP_QUEUE_LIMITS.deadlineMs);
    expect(
      (await Promise.all(results)).every(
        (e) => e instanceof DOMException && e.name === "TimeoutError",
      ),
    ).toBe(true);
    expect(task).toHaveBeenCalledTimes(8);
    expect(activeSignals.every((current) => current.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    gate.resolve();
    await flush();
    expect(task).toHaveBeenCalledTimes(8);
    queue.dispose();
  });

  it("rejects already-aborted work and sends nothing after session invalidation", async () => {
    const queue = new MapRequestQueue();
    const aborted = new AbortController();
    aborted.abort();
    const task = vi.fn(async () => undefined);
    await expect(queue.run(aborted.signal, task)).rejects.toMatchObject({ name: "AbortError" });
    const pending = queue.run(signal(), task).catch((e: unknown) => e);
    queue.dispose();
    await pending;
    await flush();
    expect(task).not.toHaveBeenCalled();
  });
});
