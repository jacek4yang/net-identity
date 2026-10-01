/** Bound data-only renderer fanout before it reaches the background broker. */
export const MAP_QUEUE_LIMITS = { active: 8, waiting: 256, deadlineMs: 60_000 } as const;

interface Job {
  active: boolean;
  start(): void;
  cancel(error: Error): void;
}

const aborted = () => new DOMException("Map request cancelled.", "AbortError");

export class MapRequestQueue {
  private readonly waiting: Job[] = [];
  private readonly jobs = new Set<Job>();
  private active = 0;
  private closed = false;

  run<T>(signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed || signal.aborted) return Promise.reject(aborted());
    if (this.active >= MAP_QUEUE_LIMITS.active && this.waiting.length >= MAP_QUEUE_LIMITS.waiting)
      return Promise.reject(new Error("The online map request queue is full."));

    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error("Online map request failed."));
      };
      const job: Job = {
        active: false,
        cancel: (error) => {
          if (settled) return;
          controller.abort(error);
          fail(error);
          if (!job.active) {
            const index = this.waiting.indexOf(job);
            if (index >= 0) this.waiting.splice(index, 1);
            this.jobs.delete(job);
          }
        },
        start: () => {
          job.active = true;
          ++this.active;
          // A cancellation between admission and this microtask must not send an RPC.
          void Promise.resolve()
            .then(() => {
              if (this.closed || controller.signal.aborted) throw aborted();
              return task(controller.signal);
            })
            .then((value) => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve(value);
            }, fail)
            .finally(() => {
              // Hold the slot until the underlying RPC settles, even when the
              // caller already timed out/aborted. Never accumulate detached work.
              --this.active;
              this.jobs.delete(job);
              this.drain();
            });
        },
      };
      const cancel = () => job.cancel(aborted());
      const timer = setTimeout(
        () => job.cancel(new DOMException("Online map request timed out.", "TimeoutError")),
        MAP_QUEUE_LIMITS.deadlineMs,
      );
      signal.addEventListener("abort", cancel, { once: true });
      this.jobs.add(job);
      if (this.active < MAP_QUEUE_LIMITS.active) job.start();
      else this.waiting.push(job);
    });
  }

  private drain(): void {
    while (!this.closed && this.active < MAP_QUEUE_LIMITS.active && this.waiting.length > 0)
      this.waiting.shift()?.start();
  }

  dispose(): void {
    this.closed = true;
    for (const job of this.jobs) job.cancel(aborted());
    this.waiting.length = 0;
  }
}
