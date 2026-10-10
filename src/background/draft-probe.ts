/** One short-lived provider request per editor; never changes the active target. */
import { IPWHOIS_ENDPOINT, parseIpWhoIsResponse } from "../geo/ipwhois";
import type { DraftInput, DraftResponse } from "../shared/draft-probe";
import type { ProxyConfig } from "../profile/schema";
import type { ProxyCredentials } from "../profile/validation";
import {
  buildProxyInfo,
  decideProxyAuth,
  type ActiveProxyTarget,
  type ProxyAuthChallenge,
} from "./proxy";

const MARKER = "ni_draft";
export interface DraftNetworkRequest {
  url: string;
  requestId: string;
  originUrl?: string;
  documentUrl?: string;
}
interface Job {
  url: string;
  abort: AbortController;
  target: ActiveProxyTarget | null;
  requestId: string | null;
  allowed: boolean;
  authClaimed: boolean;
}
export class DraftProbeBroker {
  private readonly jobs = new Map<string, Job>();
  constructor(
    private readonly deps: {
      extensionUrl: string;
      consent: () => Promise<boolean>;
      credentials: (id: string, proxy: ProxyConfig) => Promise<ProxyCredentials | null>;
      fetch: typeof fetch;
      newId: () => string;
      timeoutMs?: number;
    },
  ) {}

  isProbe(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.origin === "https://ipwho.is" && parsed.searchParams.has(MARKER);
    } catch {
      return false;
    }
  }
  private find(details: DraftNetworkRequest): Job | undefined {
    if (
      ![details.originUrl, details.documentUrl].some(
        (url) => url?.startsWith(this.deps.extensionUrl) === true,
      )
    )
      return undefined;
    return [...this.jobs.values()].find(
      (job) => job.url === details.url && !job.abort.signal.aborted,
    );
  }
  route(details: DraftNetworkRequest): (browser.proxy.ProxyInfo | null)[] {
    const job = this.find(details);
    if (!job?.target || (job.requestId !== null && job.requestId !== details.requestId))
      return [null];
    job.requestId = details.requestId;
    return [
      { ...buildProxyInfo(job.target.proxy, job.target.credentials), failoverTimeout: 1 },
      null,
    ];
  }
  allows(details: DraftNetworkRequest): boolean {
    const job = this.find(details);
    if (!job?.target || job.requestId !== details.requestId) return false;
    job.allowed = true;
    return true;
  }
  auth(details: DraftNetworkRequest, challenge: ProxyAuthChallenge): ProxyCredentials | null {
    const job = this.find(details);
    if (!job || !job.allowed || job.requestId !== details.requestId || job.authClaimed) return null;
    job.authClaimed = true;
    return decideProxyAuth(job.target, challenge);
  }
  cancel(owner: string): void {
    this.jobs.get(owner)?.abort.abort();
    this.jobs.delete(owner);
  }
  async probe(owner: string, input: DraftInput): Promise<DraftResponse> {
    this.cancel(owner);
    if (this.jobs.size >= 4) return { ok: false, error: "busy" };
    const url = new URL(IPWHOIS_ENDPOINT);
    url.searchParams.set(MARKER, this.deps.newId());
    const job: Job = {
      url: url.href,
      abort: new AbortController(),
      target: null,
      requestId: null,
      allowed: false,
      authClaimed: false,
    };
    this.jobs.set(owner, job);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      job.abort.abort();
      if (this.jobs.get(owner) === job) this.jobs.delete(owner);
    }, this.deps.timeoutMs ?? 12000);
    try {
      if (!(await this.deps.consent())) return { ok: false, error: "consent" };
      if (job.abort.signal.aborted) return { ok: false, error: timedOut ? "timeout" : "cancelled" };
      const credentials =
        input.credentials === undefined && input.profileId !== undefined
          ? await this.deps.credentials(input.profileId, input.proxy)
          : (input.credentials ?? null);
      if (job.abort.signal.aborted) return { ok: false, error: timedOut ? "timeout" : "cancelled" };
      if (input.proxy.authenticationRequired && credentials === null)
        return { ok: false, error: "credentials" };
      job.target = {
        profileId: "draft",
        profileName: "draft",
        generation: 0,
        proxy: input.proxy,
        credentials,
      };
      const response = await this.deps.fetch(job.url, {
        method: "GET",
        signal: job.abort.signal,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        headers: { accept: "application/json" },
      });
      if (!job.allowed || !response.ok || response.redirected || !response.body)
        return { ok: false, error: "provider" };
      const reader = response.body.getReader();
      let size = 0;
      let text = "";
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 65536) {
            await reader.cancel();
            return { ok: false, error: "provider" };
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      if (job.abort.signal.aborted || this.jobs.get(owner) !== job)
        return { ok: false, error: timedOut ? "timeout" : "cancelled" };
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        return { ok: false, error: "provider" };
      }
      const parsed = parseIpWhoIsResponse(payload);
      return parsed.ok ? { ok: true, identity: parsed.value } : { ok: false, error: "provider" };
    } catch {
      return {
        ok: false,
        error: timedOut ? "timeout" : job.abort.signal.aborted ? "cancelled" : "network",
      };
    } finally {
      clearTimeout(timer);
      job.abort.abort();
      if (this.jobs.get(owner) === job) this.jobs.delete(owner);
    }
  }
}
