/** Bounded, ephemeral, generation-bound access to map data. No routing changes or retries. */
import {
  isMapResourceUrl,
  MAP_STYLE_URL,
  MAX_MAP_RESOURCE_BYTES,
  type MapRequest,
  type MapFailureKind,
  type MapResponse,
} from "../shared/map-provider";
import { decideGeoIpConsent, type DataCollectionSnapshot } from "./consent";
import type { RuntimeState } from "../shared/state";
import { decideProxy, type ActiveProxyTarget } from "./proxy";

export interface MapBrokerDeps {
  state: () => RuntimeState;
  generation: () => number;
  target: () => ActiveProxyTarget | null;
  collection: () => Promise<DataCollectionSnapshot>;
  fetch: typeof fetch;
  newId: () => string;
}
interface PendingResource {
  url: string;
  abort: AbortController;
}
interface MapSession {
  owner: string;
  generation: number;
  pending: Map<string, PendingResource>;
}
const failure = (error: string, kind: MapFailureKind = "blocked"): MapResponse => ({
  ok: false,
  error,
  kind,
});
const EXPIRED = "Online map stopped. Load it again for the current route.";

export class MapResourceBroker {
  private readonly sessions = new Map<string, MapSession>();
  private epoch = 0;
  private activeRequests = 0;
  private bufferedBytes = 0;
  private readonly queue: Array<{ abort: AbortController; resume: (allowed: boolean) => void }> =
    [];
  constructor(private readonly deps: MapBrokerDeps) {}

  /** Must run synchronously before any route mutation or await in activation/Off. */
  invalidate(): void {
    ++this.epoch;
    for (const id of this.sessions.keys()) this.close(id);
  }
  closeOwner(owner: string): void {
    ++this.epoch;
    for (const [id, session] of this.sessions) if (session.owner === owner) this.close(id);
  }
  close(id: string): void {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    for (const pending of session?.pending.values() ?? []) pending.abort.abort();
  }
  private routeError(generation: number): string | null {
    const state = this.deps.state();
    if (
      generation !== this.deps.generation() ||
      state.generation !== generation ||
      state.status === "activating" ||
      state.status === "resolving" ||
      state.appliedRoute === "restoring" ||
      state.appliedRoute === "blocked" ||
      state.desiredRoute === "unknown"
    )
      return EXPIRED;
    const target = this.deps.target();
    if (state.appliedRoute === "proxy") {
      if (target === null || target.generation !== generation || target.proxy.type === "direct")
        return EXPIRED;
      if (target.proxy.authenticationRequired && target.credentials === null)
        return "Apply the required proxy credentials before loading the online map.";
      if (decideProxy(target, MAP_STYLE_URL).type === "direct")
        return "The applied bypass list includes OpenFreeMap. Change and Apply that list before loading the map.";
    }
    return null;
  }
  private async consent(generation: number, signal?: AbortSignal): Promise<boolean> {
    if (this.routeError(generation) !== null) return false;
    const unavailable = { apiAvailable: false, optionalGranted: [] };
    const pending = this.deps.collection().catch(() => unavailable);
    const snapshot =
      signal === undefined
        ? await pending
        : await new Promise<DataCollectionSnapshot>((resolve) => {
            const cancel = () => resolve(unavailable);
            if (signal.aborted) {
              cancel();
              return;
            }
            signal.addEventListener("abort", cancel, { once: true });
            void pending.then((value) => {
              signal.removeEventListener("abort", cancel);
              resolve(value);
            });
          });
    return (
      this.routeError(generation) === null &&
      decideGeoIpConsent(this.deps.state().appliedRoute === "proxy" ? "socks5" : "direct", snapshot)
        .allowed
    );
  }
  /** Extra gate after Firefox's proxy decision and the controller's routing barrier. */
  allowsNetwork(url: string): boolean {
    if (!isMapResourceUrl(url)) return false;
    for (const session of this.sessions.values()) {
      if (this.routeError(session.generation) !== null) continue;
      for (const pending of session.pending.values())
        if (pending.url === url && !pending.abort.signal.aborted) return true;
    }
    return false;
  }
  async handle(request: MapRequest, owner: string): Promise<MapResponse> {
    if (request.type !== "map:open" && this.sessions.get(request.sessionId)?.owner !== owner)
      return failure(EXPIRED);
    switch (request.type) {
      case "map:open": {
        const epoch = this.epoch;
        const error = this.routeError(request.generation);
        if (error !== null) return failure(error);
        if (!(await this.consent(request.generation)))
          return failure(
            "Allow optional public-IP collection before loading an online map on Direct or Off.",
          );
        if (epoch !== this.epoch || this.routeError(request.generation) !== null)
          return failure(EXPIRED);
        if (this.sessions.size >= 4)
          return failure("Close another online map before opening this one.");
        const sessionId = this.deps.newId();
        this.sessions.set(sessionId, { owner, generation: request.generation, pending: new Map() });
        return { ok: true, sessionId };
      }
      case "map:close":
        this.close(request.sessionId);
        return { ok: true };
      case "map:cancel":
        this.sessions.get(request.sessionId)?.pending.get(request.requestId)?.abort.abort();
        return { ok: true };
      case "map:fetch":
        return this.resource(request);
    }
  }
  private acquire(abort: AbortController): Promise<boolean> {
    if (abort.signal.aborted) return Promise.resolve(false);
    if (this.activeRequests < 8) {
      ++this.activeRequests;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const item = {
        abort,
        resume: (allowed: boolean) => {
          abort.signal.removeEventListener("abort", cancel);
          resolve(allowed);
        },
      };
      const cancel = () => {
        const index = this.queue.indexOf(item);
        if (index >= 0) this.queue.splice(index, 1);
        item.resume(false);
      };
      this.queue.push(item);
      abort.signal.addEventListener("abort", cancel, { once: true });
    });
  }
  private release(): void {
    --this.activeRequests;
    const next = this.queue.shift();
    if (next !== undefined) {
      ++this.activeRequests;
      next.resume(true);
    }
  }
  private async resource(
    request: Extract<MapRequest, { type: "map:fetch" }>,
  ): Promise<MapResponse> {
    const session = this.sessions.get(request.sessionId);
    if (session === undefined || !isMapResourceUrl(request.url)) return failure(EXPIRED);
    // Match the exact URL serialization Firefox uses for webRequest correlation.
    // Validate before normalization; spaces in font stacks are legitimate, while
    // credentials, encoded separators and unrelated resources remain forbidden.
    const url = new URL(request.url).href;
    const error = this.routeError(session.generation);
    if (error !== null) return failure(error);
    const pendingCount = [...this.sessions.values()].reduce(
      (count, item) => count + item.pending.size,
      0,
    );
    if (pendingCount >= 64 || session.pending.size >= 32 || session.pending.has(request.requestId))
      return failure("Too many map requests. Reload the online map.", "unavailable");
    const abort = new AbortController();
    session.pending.set(request.requestId, { url, abort });
    const timeout = setTimeout(() => abort.abort(), 20_000);
    let acquired = false;
    let buffered = 0;
    try {
      if (
        !(await this.consent(session.generation, abort.signal)) ||
        abort.signal.aborted ||
        !this.sessions.has(request.sessionId)
      )
        return failure(EXPIRED);
      acquired = await this.acquire(abort);
      if (!acquired || abort.signal.aborted || this.routeError(session.generation) !== null)
        return failure(EXPIRED);
      const response = await this.deps.fetch(url, {
        method: "GET",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        cache: "no-store",
        signal: abort.signal,
      });
      if (!response.ok || response.redirected || response.body === null)
        return failure("OpenFreeMap did not return map data.", "unavailable");
      const length = Number(response.headers.get("content-length"));
      if (length > MAX_MAP_RESOURCE_BYTES)
        return failure("Map resource exceeds the size limit.", "unavailable");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (
            size > MAX_MAP_RESOURCE_BYTES ||
            this.bufferedBytes + chunk.value.byteLength > 16 * 1024 * 1024 ||
            abort.signal.aborted ||
            this.routeError(session.generation) !== null
          ) {
            await reader.cancel();
            return failure(
              "Map resource stopped or exceeds the size limit.",
              abort.signal.aborted || this.routeError(session.generation) !== null
                ? "blocked"
                : "unavailable",
            );
          }
          buffered += chunk.value.byteLength;
          this.bufferedBytes += chunk.value.byteLength;
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      if (
        abort.signal.aborted ||
        !this.sessions.has(request.sessionId) ||
        this.routeError(session.generation) !== null
      )
        return failure(EXPIRED);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { ok: true, data: bytes.buffer };
    } catch {
      return failure(
        "Online map unavailable on this route. Coordinates still work offline.",
        this.sessions.has(request.sessionId) && this.routeError(session.generation) === null
          ? "unavailable"
          : "blocked",
      );
    } finally {
      clearTimeout(timeout);
      abort.abort();
      session.pending.delete(request.requestId);
      this.bufferedBytes -= buffered;
      if (acquired) this.release();
    }
  }
}
