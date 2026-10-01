import { describe, expect, it } from "vitest";
import {
  isMapResourceUrl,
  MAP_STYLE_URL,
  mapFailureMustStop,
  MAX_MAP_RESOURCE_BYTES,
  parseMapRequest,
  parseMapResponse,
} from "../src/shared/map-provider";
import { mapLibreCamera, worldSize, viewportPoint } from "../src/options/location-map";
import { LocationMapModel } from "../src/options/map-model";

describe("reviewed map provider boundary", () => {
  it("allows only inspected OpenFreeMap data resource families", () => {
    for (const suffix of [
      "/styles/liberty",
      "/planet",
      "/planet/20260927_080001_pt/14/14551/6451.pbf",
      "/natural_earth/ne2sr/2/1/2.png",
      "/sprites/ofm_f384/ofm@2x.png",
      "/sprites/ofm_f384/ofm.json",
      "/fonts/Noto%20Sans%20Regular/0-255.pbf",
    ])
      expect(isMapResourceUrl(`https://tiles.openfreemap.org${suffix}`), suffix).toBe(true);
  });
  it("rejects alternate origins, code, credentials, redirects-as-URLs and encoded path escapes", () => {
    for (const url of [
      "https://evil.example/styles/liberty",
      "http://tiles.openfreemap.org/planet",
      "https://tiles.openfreemap.org.evil.example/planet",
      "https://user:pass@tiles.openfreemap.org/planet",
      `${MAP_STYLE_URL}?token=secret`,
      `${MAP_STYLE_URL}#token`,
      "https://tiles.openfreemap.org/script.js",
      "https://tiles.openfreemap.org/fonts/a%2fb/0-255.pbf",
      "https://tiles.openfreemap.org/fonts/a%5cb/0-255.pbf",
      "https://tiles.openfreemap.org/fonts/a%00b/0-255.pbf",
      "https://tiles.openfreemap.org/fonts/%2e%2e/0-255.pbf",
      "data:application/json,{}",
      "ni-map://example",
      "not a URL",
    ])
      expect(isMapResourceUrl(url), url).toBe(false);
  });
  it("keeps a loaded basemap after isolated network errors but stops for policy and initial failures", () => {
    expect(mapFailureMustStop(true, "unavailable")).toBe(false);
    expect(mapFailureMustStop(false, "unavailable")).toBe(true);
    expect(mapFailureMustStop(true, "blocked")).toBe(true);
    expect(mapFailureMustStop(false, "blocked")).toBe(true);
    expect(parseMapResponse({ ok: false, error: "offline", kind: "unavailable" })).toEqual({
      ok: true,
      value: { ok: false, error: "offline", kind: "unavailable" },
    });
    expect(parseMapResponse({ ok: false, error: "offline", kind: "unexpected" }).ok).toBe(false);
  });
  it("parses every map message and rejects malformed or unbounded payloads", () => {
    expect(parseMapRequest({ type: "map:open", generation: 1 })).toEqual({
      ok: true,
      value: { type: "map:open", generation: 1 },
    });
    for (const type of ["map:close", "map:cancel", "map:fetch"])
      expect(
        parseMapRequest({ type, sessionId: "a-1", requestId: "b-2", url: MAP_STYLE_URL }).ok,
      ).toBe(true);
    for (const input of [
      null,
      {},
      { type: "map:open", generation: -1 },
      { type: "map:open", generation: NaN },
      { type: "map:fetch", sessionId: "a", requestId: "b", url: "https://evil.example" },
      { type: "map:close", sessionId: "x".repeat(81) },
    ])
      expect(parseMapRequest(input).ok).toBe(false);
    expect(parseMapResponse({ ok: true, data: new ArrayBuffer(16) }).ok).toBe(true);
    expect(parseMapResponse({ ok: false, error: "Map unavailable" }).ok).toBe(true);
    expect(
      parseMapResponse({ ok: true, data: new ArrayBuffer(MAX_MAP_RESOURCE_BYTES + 1) }).ok,
    ).toBe(false);
    expect(parseMapResponse({ ok: true, data: {} }).ok).toBe(false);
    expect(parseMapResponse({ ok: false, error: "x".repeat(301) }).ok).toBe(false);
  });
});
describe("basemap camera and local gesture agreement", () => {
  it("matches the 256px local world at every zoom, antimeridian, poles and resize", () => {
    for (const longitude of [-180, 0, 180])
      for (const latitude of [-90, 0, 90])
        for (const zoom of [0, 2, 9, 18]) {
          const model = new LocationMapModel();
          model.reset({ latitude, longitude }, zoom, true);
          model.resize(1000, 300);
          const camera = mapLibreCamera(model.viewport);
          expect(camera.center).toEqual([longitude, model.viewport.center.latitude]);
          expect(512 * 2 ** camera.zoom).toBe(worldSize(zoom));
          expect(viewportPoint(model.viewport, latitude, longitude)).toEqual({ x: 500, y: 150 });
          expect(model.selection).toEqual({ latitude, longitude });
        }
  });
});
