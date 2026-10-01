/** Bounded, in-memory evidence only. Never changes the selected route or retries HTTP. */
import { normalizeHost } from "../shared/primitives";

export type ProxyHealth = "healthy" | "suspect" | "unavailable" | "recovering";
export interface ProxyEndpoint {
  type: string;
  host: string;
  port: number;
}
export interface NetworkObservation {
  requestId: string;
  url: string;
  proxyInfo?: unknown;
  fromCache?: boolean;
  error?: unknown;
}
interface RequestSample {
  generation: number;
  endpoint: ProxyEndpoint;
  origin: string;
  started: number;
}
interface FailureBucket {
  at: number;
  origins: Set<string>;
}
const WINDOW_MS = 5000;
const BUCKET_MS = 300;
const REQUEST_TTL_MS = 30000;
const MAX_REQUESTS = 512;

/** Copy only routing fields. Never retain credentials from browser event objects. */
export function sanitizeProxyEndpoint(value: unknown): ProxyEndpoint | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.type !== "string" ||
    !["socks", "socks4", "http", "https"].includes(candidate.type) ||
    typeof candidate.host !== "string" ||
    candidate.host.length === 0 ||
    typeof candidate.port !== "number" ||
    !Number.isInteger(candidate.port) ||
    candidate.port < 1 ||
    candidate.port > 65535
  )
    return null;
  return { type: candidate.type, host: normalizeHost(candidate.host), port: candidate.port };
}

/** proxyInfo identifies a configured route, NOT a successful SOCKS handshake. */
export class ProxyHealthTracker {
  private generation = 0;
  private health: ProxyHealth = "healthy";
  private requests = new Map<string, RequestSample>();
  private failures: FailureBucket[] = [];
  private recoveryStart: number | null = null;
  private recoveryCount = 0;
  private cooldownStep = 0;
  private cooldownUntil = 0;

  constructor(private readonly now: () => number) {}

  get status(): ProxyHealth {
    return this.health;
  }
  get trackedRequestCount(): number {
    return this.requests.size;
  }

  reset(generation: number): void {
    this.generation = generation;
    this.health = "healthy";
    this.requests.clear();
    this.failures = [];
    this.recoveryStart = null;
    this.recoveryCount = 0;
    this.cooldownStep = 0;
    this.cooldownUntil = 0;
  }

  track(requestId: string, generation: number, url: string, endpoint: ProxyEndpoint): void {
    if (generation !== this.generation || requestId.length === 0) return;
    const sanitized = sanitizeProxyEndpoint(endpoint);
    if (sanitized === null) return;
    let origin: string;
    try {
      origin = new URL(url).hostname;
    } catch {
      return;
    }
    this.prune();
    if (!this.requests.has(requestId) && this.requests.size >= MAX_REQUESTS) {
      const oldest = this.requests.keys().next().value;
      if (oldest !== undefined) this.requests.delete(oldest);
    }
    // Keep only the hostname: no URL paths, query strings, headers or credentials.
    this.requests.set(requestId, {
      generation,
      endpoint: sanitized,
      origin,
      started: this.now(),
    });
  }

  observe(details: NetworkObservation, success: boolean): boolean {
    const previous = this.health;
    this.prune();
    const sample = this.requests.get(details.requestId);
    this.requests.delete(details.requestId);
    const endpoint = sanitizeProxyEndpoint(details.proxyInfo);
    if (
      sample === undefined ||
      sample.generation !== this.generation ||
      endpoint === null ||
      endpoint.type !== sample.endpoint.type ||
      endpoint.host !== sample.endpoint.host ||
      endpoint.port !== sample.endpoint.port ||
      details.fromCache === true
    )
      return false;
    let origin: string;
    try {
      origin = new URL(details.url).hostname;
    } catch {
      return false;
    }
    if (origin !== sample.origin) return false;
    if (success) {
      if (details.fromCache !== false) return false;
      if (this.health === "healthy") {
        this.failures = [];
        return false;
      }
      this.health = "recovering";
      this.recoveryStart ??= this.now();
      this.recoveryCount += 1;
      if (this.recoveryCount >= 3 && this.now() - this.recoveryStart >= 1000) {
        this.health = "healthy";
        this.failures = [];
        this.cooldownStep = 0;
        this.cooldownUntil = 0;
        this.recoveryStart = null;
        this.recoveryCount = 0;
      }
    } else {
      // Error names can exclude known cancellation, but never prove a proxy outage.
      if (
        typeof details.error !== "string" ||
        /ABORT|CANCEL|BINDING_REDIRECTED/i.test(details.error)
      )
        return false;
      this.recoveryStart = null;
      this.recoveryCount = 0;
      const now = this.now();
      const last = this.failures.at(-1);
      if (last !== undefined && now - last.at < BUCKET_MS) {
        if (last.origins.size < 2) last.origins.add(origin);
      } else this.failures.push({ at: now, origins: new Set([origin]) });
      // Several independent time buckets AND destinations warrant suspicion only.
      // Firefox supplies no transport-phase proof; unavailable is intentionally not
      // entered from generic webRequest errors, even with matching proxyInfo.
      const origins = new Set(this.failures.flatMap((bucket) => [...bucket.origins]));
      if (this.failures.length >= 3 && origins.size >= 2) {
        this.health = "suspect";
        if (last === undefined || now - last.at >= BUCKET_MS) {
          this.cooldownUntil = now + Math.min(2000, 250 * 2 ** this.cooldownStep);
          this.cooldownStep = Math.min(3, this.cooldownStep + 1);
        }
      } else if (this.health === "recovering") this.health = "suspect";
    }
    return previous !== this.health;
  }

  cooldownMs(): number {
    return this.health === "healthy"
      ? 0
      : Math.max(0, Math.min(2000, this.cooldownUntil - this.now()));
  }

  private prune(): void {
    const now = this.now();
    for (const [id, request] of this.requests) {
      if (now - request.started > REQUEST_TTL_MS) this.requests.delete(id);
    }
    this.failures = this.failures.filter((bucket) => now - bucket.at <= WINDOW_MS);
  }
}

/** One shared timer and at most 128 waiting decisions. Overflow uses the same route immediately. */
export class ProxyCooldown {
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private release: (() => void) | null = null;
  private waiters = 0;

  wait(ms: number): Promise<void> | null {
    if (ms <= 0) return null;
    if (this.pending !== null) {
      if (this.waiters >= 128) return null;
      this.waiters += 1;
      return this.pending;
    }
    this.waiters = 1;
    this.pending = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    this.timer = setTimeout(() => this.cancel(), Math.min(2000, ms));
    return this.pending;
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const release = this.release;
    this.release = null;
    this.pending = null;
    this.waiters = 0;
    release?.();
  }
}
