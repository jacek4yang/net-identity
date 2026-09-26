import { describe, expect, it } from "vitest";
import {
  accuracyRadiusPixels,
  applyResolvedLocation,
  latLngFromViewport,
  mapTileUrl,
  panViewport,
  seedBlankManualFields,
  tileRadius,
  viewportPoint,
  visibleTiles,
  zoomToFitAccuracy,
  type MapViewport,
} from "../src/options/location-map";

const view = (centerLat: number, centerLng: number): MapViewport => ({
  width: 400,
  height: 200,
  zoom: 2,
  center: { latitude: centerLat, longitude: centerLng },
});

describe("location map projection", () => {
  it("round-trips a click at the centre and an offset point", () => {
    const viewport = view(48.8, 2.3);
    const centre = latLngFromViewport(viewport, { x: 200, y: 100 });
    expect(centre.latitude).toBeCloseTo(48.8, 5);
    expect(centre.longitude).toBeCloseTo(2.3, 5);

    const point = viewportPoint(viewport, 51.5, -0.12);
    const back = latLngFromViewport(viewport, point);
    expect(back.latitude).toBeCloseTo(51.5, 4);
    expect(back.longitude).toBeCloseTo(-0.12, 4);
  });

  it("builds OpenStreetMap tile URLs and rejects indexes outside the zoom", () => {
    expect(mapTileUrl(2, 1, 1)).toBe("https://tile.openstreetmap.org/2/1/1.png");
    expect(mapTileUrl(2, 4, 0)).toBeNull();
    expect(mapTileUrl(2, 1.5, 0)).toBeNull();
  });

  it("moves the centre west when the map is dragged right, and a click left of centre does too", () => {
    const viewport = view(48.8, 2.3);
    const dragged = panViewport(viewport, 80, 0);
    expect(dragged.longitude).toBeLessThan(2.3);
    const returned = panViewport({ ...viewport, center: dragged }, -80, 0);
    expect(returned.longitude).toBeCloseTo(2.3, 4);
    expect(returned.latitude).toBeCloseTo(48.8, 4);

    const clicked = latLngFromViewport(viewport, { x: 0, y: viewport.height / 2 });
    expect(clicked.longitude).toBeLessThan(viewport.center.longitude);
  });

  it("sizes the accuracy circle and picks a zoom that keeps a coarse radius visible", () => {
    expect(accuracyRadiusPixels(34.2, 0, 4)).toBe(0);
    expect(zoomToFitAccuracy(34.2, Number.NaN, 280)).toBe(4);
    const zoom = zoomToFitAccuracy(34.2, 20_000, 280);
    const radius = accuracyRadiusPixels(34.2, 20_000, zoom);
    expect(radius).toBeGreaterThan(40);
    expect(radius).toBeLessThan(120);
    expect(accuracyRadiusPixels(34.2, 40_000, zoom)).toBeGreaterThan(radius);
  });

  it("omits tiles past the poles and still covers a wrapped longitude with image URLs only", () => {
    const span = tileRadius(256);
    const full = (span * 2 + 1) ** 2;
    const north = visibleTiles({
      width: 256,
      height: 256,
      zoom: 2,
      center: { latitude: 80, longitude: 0 },
    });
    expect(north.length).toBeLessThan(full);
    expect(north.every((tile) => tile.url.endsWith(".png"))).toBe(true);

    const edge = visibleTiles({
      width: 256,
      height: 256,
      zoom: 2,
      center: { latitude: 0, longitude: 179 },
    });
    expect(edge.length).toBe(full);
    expect(
      edge.every((tile) =>
        /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/.test(tile.url),
      ),
    ).toBe(true);
  });
});

describe("manual location seeding", () => {
  const blank = { latitude: "", longitude: "", accuracy: "", timezone: "" };
  const resolved = { latitude: 34.2, longitude: 108.9, accuracy: 20000, timezone: "Asia/Shanghai" };

  it("seeds blank fields from the resolved identity and keeps later edits", () => {
    expect(seedBlankManualFields(blank, resolved, false)).toEqual({
      latitude: "34.2",
      longitude: "108.9",
      accuracy: "20000",
      timezone: "Asia/Shanghai",
    });
    const edited = { latitude: "10", longitude: "20", accuracy: "50", timezone: "UTC" };
    expect(seedBlankManualFields(edited, resolved, true)).toEqual(edited);
    expect(seedBlankManualFields({ ...blank, latitude: "1" }, resolved, false).latitude).toBe("1");
  });

  it("replaces the manual point when the user asks for the GeoIP location", () => {
    const edited = { latitude: "10", longitude: "20", accuracy: "50", timezone: "UTC" };
    expect(applyResolvedLocation(edited, resolved)).toEqual({
      latitude: "34.2",
      longitude: "108.9",
      accuracy: "20000",
      timezone: "Asia/Shanghai",
    });
  });
});
