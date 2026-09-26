import { describe, expect, it } from "vitest";
import { GeoIpError, describeGeoIpFailure } from "../src/geo/provider";
import {
  IPWHOIS_ENDPOINT,
  createIpWhoIsProvider,
  parseIpWhoIsResponse,
  type FetchLike,
} from "../src/geo/ipwhois";

const VALID_PAYLOAD = {
  success: true,
  ip: "203.0.113.7",
  country_code: "nl",
  region: "North Holland",
  city: "Amsterdam",
  latitude: 52.374,
  longitude: 4.88969,
  timezone: { id: "Europe/Amsterdam", abbr: "CET" },
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchRecorder {
  calls: { url: string; init: RequestInit | undefined }[];
  fetchImpl: FetchLike;
}

function createFetchRecorder(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): FetchRecorder {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  };
}

describe("parseIpWhoIsResponse", () => {
  it("parses a complete response and normalises the country code", () => {
    const parsed = parseIpWhoIsResponse(VALID_PAYLOAD);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value : null).toEqual({
      ip: "203.0.113.7",
      countryCode: "NL",
      region: "North Holland",
      city: "Amsterdam",
      latitude: 52.374,
      longitude: 4.88969,
      timezone: "Europe/Amsterdam",
    });
  });

  it("accepts a plain string timezone as well as the object form", () => {
    const parsed = parseIpWhoIsResponse({ ...VALID_PAYLOAD, timezone: "Asia/Tokyo" });
    expect(parsed.ok && parsed.value.timezone).toBe("Asia/Tokyo");
  });

  it("sanitises provider text instead of trusting it", () => {
    const parsed = parseIpWhoIsResponse({
      ...VALID_PAYLOAD,
      city: "Xi\u2019an\u0000\u0007",
      region: "  North   Holland  ",
      countryCode: "DE",
    });
    expect(parsed.ok && parsed.value.city).toBe("Xi\u2019an");
    expect(parsed.ok && parsed.value.region).toBe("North Holland");
  });

  it("truncates over-long text fields", () => {
    const parsed = parseIpWhoIsResponse({ ...VALID_PAYLOAD, city: "a".repeat(500) });
    expect(parsed.ok && parsed.value.city?.length).toBeLessThanOrEqual(96);
  });

  it("discards malformed optional fields without failing the lookup", () => {
    const parsed = parseIpWhoIsResponse({
      ...VALID_PAYLOAD,
      country_code: "NETHERLANDS",
      region: 42,
      city: null,
      latitude: "52.374",
      longitude: null,
      timezone: "Mars/Olympus",
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value : null).toEqual({ ip: "203.0.113.7" });
  });

  it("drops a partial or out-of-range position instead of guessing", () => {
    const missingLongitude = parseIpWhoIsResponse({ ...VALID_PAYLOAD, longitude: undefined });
    expect(missingLongitude.ok && missingLongitude.value.latitude).toBeUndefined();

    const outOfRange = parseIpWhoIsResponse({ ...VALID_PAYLOAD, latitude: 91 });
    expect(outOfRange.ok && outOfRange.value.latitude).toBeUndefined();
    expect(outOfRange.ok && outOfRange.value.longitude).toBeUndefined();
  });

  it("requires a successful response with a valid IP address", () => {
    for (const ip of [undefined, "", "not-an-ip", "999.1.1.1", 42, null]) {
      expect(parseIpWhoIsResponse({ ...VALID_PAYLOAD, ip }).ok, `ip=${String(ip)}`).toBe(false);
    }
    expect(parseIpWhoIsResponse({ ...VALID_PAYLOAD, success: undefined }).ok).toBe(false);
    expect(parseIpWhoIsResponse({ ...VALID_PAYLOAD, success: "yes" }).ok).toBe(false);
  });

  it("surfaces a provider-side failure message", () => {
    const parsed = parseIpWhoIsResponse({ success: false, message: "rate limit reached" });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.errors.join(" ")).toContain("rate limit reached");
  });

  it("rejects values that are not JSON objects", () => {
    for (const value of [null, undefined, 42, "json", [], true]) {
      expect(parseIpWhoIsResponse(value).ok, String(value)).toBe(false);
    }
  });
});

describe("createIpWhoIsProvider", () => {
  it("requests the documented endpoint with no credentials, cookies or caching", async () => {
    const recorder = createFetchRecorder(async () => jsonResponse(VALID_PAYLOAD));
    const provider = createIpWhoIsProvider({ fetchImpl: recorder.fetchImpl });

    const result = await provider.resolve();

    expect(result.ip).toBe("203.0.113.7");
    expect(recorder.calls).toHaveLength(1);
    const call = recorder.calls[0];
    expect(call?.url).toBe(IPWHOIS_ENDPOINT);
    expect(call?.init?.method).toBe("GET");
    expect(call?.init?.credentials).toBe("omit");
    expect(call?.init?.cache).toBe("no-store");
    expect(call?.init?.referrerPolicy).toBe("no-referrer");
    expect(call?.init?.body).toBeUndefined();
    expect(JSON.stringify(call?.init?.headers)).not.toMatch(/authorization|proxy/i);
  });

  it("reports HTTP failures with the status code", async () => {
    const recorder = createFetchRecorder(async () => new Response("nope", { status: 502 }));
    const provider = createIpWhoIsProvider({ fetchImpl: recorder.fetchImpl });

    await expect(provider.resolve()).rejects.toMatchObject({ code: "http", status: 502 });
  });

  it("reports malformed JSON and malformed payloads", async () => {
    const badJson = createFetchRecorder(async () => new Response("not json", { status: 200 }));
    await expect(
      createIpWhoIsProvider({ fetchImpl: badJson.fetchImpl }).resolve(),
    ).rejects.toMatchObject({
      code: "malformed",
    });

    const badPayload = createFetchRecorder(async () =>
      jsonResponse({ success: false, message: "nope" }),
    );
    await expect(
      createIpWhoIsProvider({ fetchImpl: badPayload.fetchImpl }).resolve(),
    ).rejects.toMatchObject({
      code: "malformed",
    });
  });

  it("reports transport failures", async () => {
    const recorder = createFetchRecorder(async () => {
      throw new TypeError("network error");
    });
    await expect(
      createIpWhoIsProvider({ fetchImpl: recorder.fetchImpl }).resolve(),
    ).rejects.toMatchObject({
      code: "network",
    });
  });

  it("aborts a lookup that exceeds the timeout", async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new TypeError("aborted")));
      });
    const provider = createIpWhoIsProvider({ fetchImpl: hanging, timeoutMs: 20 });

    await expect(provider.resolve()).rejects.toMatchObject({ code: "timeout" });
  });

  it("honours an external abort signal", async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new TypeError("aborted")));
      });
    const provider = createIpWhoIsProvider({
      fetchImpl: hanging,
      timeoutMs: 5000,
      endpoint: IPWHOIS_ENDPOINT,
    });

    const controller = new AbortController();
    const pending = provider.resolve(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(provider.resolve(alreadyAborted.signal)).rejects.toMatchObject({
      code: "aborted",
    });
  });
});

describe("describeGeoIpFailure", () => {
  it("maps every error code to a precise message", () => {
    expect(describeGeoIpFailure(new GeoIpError("timeout", "timed out"))).toContain("timed out");
    expect(describeGeoIpFailure(new GeoIpError("aborted", "cancelled"))).toContain("cancelled");
    expect(describeGeoIpFailure(new GeoIpError("http", "http", 403))).toContain("403");
    expect(describeGeoIpFailure(new GeoIpError("network", "network"))).toContain("proxy");
    expect(describeGeoIpFailure(new GeoIpError("malformed", "bad"))).toContain("unusable");
    expect(describeGeoIpFailure(new Error("something else"))).toBe("GeoIP lookup failed.");
    expect(describeGeoIpFailure(undefined)).toBe("GeoIP lookup failed.");
  });
});
