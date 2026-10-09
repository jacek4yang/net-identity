import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftProbeBroker } from "../src/background/draft-probe";
import {
  parseDraftRequest,
  parseDraftResponse,
  type DraftInput,
  type DraftResponse,
} from "../src/shared/draft-probe";
import { DraftCheck } from "../src/shared/draft-check";
import { createDeferred } from "./helpers";

const input: DraftInput = {
  proxy: { type: "socks5", host: "127.0.0.1", port: 1080, proxyDNS: true, bypassHosts: [] },
};
const owner = "editor-test-123456";
const extensionUrl = "moz-extension://test-id/";
const payload = {
  success: true,
  ip: "203.0.113.20",
  latitude: 35,
  longitude: 139,
  timezone: { id: "Asia/Tokyo" },
};
function harness() {
  let seq = 0;
  const credentials = vi.fn(async () => null as { username: string; password: string } | null);
  const fetcher = vi.fn<typeof fetch>();
  const broker = new DraftProbeBroker({
    extensionUrl,
    consent: async () => true,
    credentials,
    fetch: fetcher,
    newId: () => `token-${++seq}`,
    timeoutMs: 100,
  });
  const details = (url: string) => ({
    url,
    requestId: url,
    originUrl: extensionUrl + "background/index.js",
  });
  fetcher.mockImplementation(async (url) => {
    const request = details(
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
    );
    broker.route(request);
    broker.allows(request);
    return Response.json(payload);
  });
  return { broker, fetcher, credentials, details };
}
afterEach(() => vi.useRealTimers());
describe("draft probe boundary", () => {
  it("validates input without reflecting malformed or credential-bearing values", () => {
    expect(parseDraftRequest({ type: "draft:probe", owner, input }).ok).toBe(true);
    for (const proxy of [
      { type: "direct" },
      { ...input.proxy, port: 0 },
      { ...input.proxy, host: "user:secret@host" },
    ])
      expect(parseDraftRequest({ type: "draft:probe", owner, input: { proxy } })).toEqual({
        ok: false,
        errors: ["Draft checks require a proxy"],
      });
    expect(parseDraftRequest({ type: "draft:probe", owner: "bad", input }).ok).toBe(false);
  });
  it("rejects invalid credentials, SOCKS4 auth and profile ids", () => {
    for (const patch of [
      { credentials: { password: 9 } },
      { credentials: { username: "a" }, proxy: { ...input.proxy, type: "socks4" } },
      { profileId: {} },
    ])
      expect(
        parseDraftRequest({ type: "draft:probe", owner, input: { ...input, ...patch } }).ok,
      ).toBe(false);
  });
  it("validates responses and drops unknown fields", () => {
    expect(
      parseDraftResponse({ ok: true, identity: { ip: "203.0.113.20", password: "secret" } }),
    ).toEqual({ ok: true, value: { ok: true, identity: { ip: "203.0.113.20" } } });
    expect(parseDraftResponse({ ok: true, identity: { ip: "invalid" } }).ok).toBe(false);
    expect(parseDraftResponse({ ok: false, error: "arbitrary secret" }).ok).toBe(false);
  });
  it.each(["socks5", "socks4", "http", "https"] as const)(
    "routes only the bound %s probe with terminal null",
    async (type) => {
      const h = harness();
      h.fetcher.mockImplementation(async (url, init) => {
        const request = h.details(
          typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
        );
        expect(h.broker.route(request)).toEqual([
          {
            type: type === "socks5" ? "socks" : type,
            host: "127.0.0.1",
            port: 1080,
            ...(type.startsWith("socks") ? { proxyDNS: true } : {}),
            failoverTimeout: 1,
          },
          null,
        ]);
        expect(h.broker.allows(request)).toBe(true);
        expect(init).toMatchObject({
          redirect: "error",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
        });
        expect(h.broker.route({ ...request, originUrl: "https://evil.invalid/" })).toEqual([null]);
        expect(h.broker.allows({ ...request, requestId: "different" })).toBe(false);
        return Response.json(payload);
      });
      expect(await h.broker.probe(owner, { proxy: { ...input.proxy, type } })).toMatchObject({
        ok: true,
        identity: { timezone: "Asia/Tokyo" },
      });
      const finished = h.details(h.fetcher.mock.calls[0]?.[0] as string);
      expect(h.broker.route(finished)).toEqual([null]);
      expect(h.broker.allows(finished)).toBe(false);
    },
  );
  it("blocks stale markers after suspension without a tombstone cache", () => {
    const h = harness();
    const url = "https://ipwho.is/?ni_draft=expired";
    expect(h.broker.isProbe(url)).toBe(true);
    expect(h.broker.isProbe("https://ipwho.is/?fields=ip")).toBe(false);
    expect(h.broker.route(h.details(url))).toEqual([null]);
    expect(h.broker.allows(h.details(url))).toBe(false);
  });
  it("refuses success without the browser routing and request gates", async () => {
    const h = harness();
    h.fetcher.mockResolvedValue(Response.json(payload));
    expect(await h.broker.probe(owner, input)).toEqual({ ok: false, error: "provider" });
  });
  it("does not fetch without confirmed install consent", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const broker = new DraftProbeBroker({
      extensionUrl,
      consent: async () => false,
      credentials: async () => null,
      fetch: fetcher,
      newId: () => "test",
    });
    expect(await broker.probe(owner, input)).toEqual({ ok: false, error: "consent" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not fetch when required session credentials are missing", async () => {
    const h = harness();
    expect(
      await h.broker.probe(owner, {
        proxy: { ...input.proxy, authenticationRequired: true },
        profileId: "saved-profile",
      }),
    ).toEqual({ ok: false, error: "credentials" });
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("uses explicit clear instead of saved credentials", async () => {
    const h = harness();
    await h.broker.probe(owner, { ...input, profileId: "saved-profile", credentials: null });
    expect(h.credentials).not.toHaveBeenCalled();
  });
  it("answers only one matching HTTP proxy challenge, never origin auth", async () => {
    const h = harness();
    h.fetcher.mockImplementation(async (url) => {
      const r = h.details(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      h.broker.route(r);
      h.broker.allows(r);
      expect(
        h.broker.auth(r, { isProxy: true, challengerHost: "127.0.0.1", challengerPort: 1080 }),
      ).toEqual({ username: "u", password: "p" });
      expect(
        h.broker.auth(r, { isProxy: true, challengerHost: "127.0.0.1", challengerPort: 1080 }),
      ).toBeNull();
      return Response.json(payload);
    });
    expect(
      await h.broker.probe(owner, {
        proxy: { ...input.proxy, type: "http" },
        credentials: { username: "u", password: "p" },
      }),
    ).toMatchObject({ ok: true });
  });
  it.each([
    { isProxy: false, challengerHost: "127.0.0.1", challengerPort: 1080 },
    { isProxy: true, challengerHost: "other", challengerPort: 1080 },
    { isProxy: true, challengerHost: "127.0.0.1", challengerPort: 1081 },
  ])("denies mismatched challenge %j", async (challenge) => {
    const h = harness();
    h.fetcher.mockImplementation(async (url) => {
      const r = h.details(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      h.broker.route(r);
      h.broker.allows(r);
      expect(h.broker.auth(r, challenge)).toBeNull();
      return Response.json(payload);
    });
    await h.broker.probe(owner, {
      proxy: { ...input.proxy, type: "http" },
      credentials: { username: "u", password: "p" },
    });
  });
  it("cancels before a delayed credential read can start the request", async () => {
    const h = harness();
    const delayed = createDeferred<null>();
    h.credentials.mockReturnValue(delayed.promise);
    const running = h.broker.probe(owner, { ...input, profileId: "saved-profile" });
    h.broker.cancel(owner);
    delayed.resolve(null);
    expect(await running).toEqual({ ok: false, error: "cancelled" });
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("latest draft cancels the older request and cannot be removed by its finally", async () => {
    const h = harness();
    const delayed = createDeferred<Response>();
    h.fetcher.mockImplementationOnce(async (url) => {
      const r = h.details(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      h.broker.route(r);
      h.broker.allows(r);
      return delayed.promise;
    });
    const old = h.broker.probe(owner, input);
    const fresh = h.broker.probe(owner, { proxy: { ...input.proxy, port: 1081 } });
    delayed.resolve(Response.json(payload));
    expect(await old).toEqual({ ok: false, error: "cancelled" });
    expect(await fresh).toMatchObject({ ok: true });
  });
  it("bounds parallel editors and releases every slot on cancellation", async () => {
    const h = harness();
    h.fetcher.mockImplementation(
      async (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        ),
    );
    const pending = ["a", "b", "c", "d"].map((id) => h.broker.probe(id, input));
    expect(await h.broker.probe("e", input)).toEqual({ ok: false, error: "busy" });
    for (const id of ["a", "b", "c", "d"]) h.broker.cancel(id);
    expect((await Promise.all(pending)).every((r) => !r.ok && r.error === "cancelled")).toBe(true);
  });
  it("times out and reports no raw errors or credentials", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.fetcher.mockImplementation(
      async (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("user:secret")), {
            once: true,
          }),
        ),
    );
    const pending = h.broker.probe(owner, input);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toEqual({ ok: false, error: "timeout" });
  });
  it.each(["oversize", "malformed", "http"])("rejects %s provider data", async (kind) => {
    const h = harness();
    h.fetcher.mockImplementation(async (url) => {
      const r = h.details(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      h.broker.route(r);
      h.broker.allows(r);
      return kind === "oversize"
        ? new Response("x".repeat(65537))
        : kind === "malformed"
          ? new Response("not-json")
          : new Response("no", { status: 503 });
    });
    expect(await h.broker.probe(owner, input)).toEqual({ ok: false, error: "provider" });
  });
});
describe("draft editor lifecycle", () => {
  it("debounces typing and suppresses late old results", async () => {
    vi.useFakeTimers();
    const late = createDeferred<DraftResponse>();
    const send = vi.fn(async (type: string) =>
      type === "draft:probe" ? late.promise : { ok: false as const, error: "cancelled" as const },
    );
    const render = vi.fn();
    const editor = new DraftCheck({ send, render });
    editor.schedule(input);
    await vi.advanceTimersByTimeAsync(300);
    editor.schedule(input);
    await vi.advanceTimersByTimeAsync(699);
    expect(send.mock.calls.filter(([type]) => type === "draft:probe")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    editor.cancel();
    late.resolve({ ok: true, identity: { ip: "203.0.113.20" } });
    await vi.advanceTimersByTimeAsync(1);
    expect(render.mock.calls.some(([state]) => state === "success")).toBe(false);
  });
  it("does not retry on network failure, but supports an explicit new attempt", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => ({ ok: false as const, error: "network" as const }));
    const render = vi.fn();
    const editor = new DraftCheck({ send, render });
    editor.schedule(input);
    await vi.advanceTimersByTimeAsync(10000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenLastCalledWith("error", { ok: false, error: "network" });
    editor.schedule(input, 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(4);
  });
});
