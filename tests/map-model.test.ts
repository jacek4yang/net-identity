import { describe, expect, it } from "vitest";
import { LocationMapModel } from "../src/options/map-model";
import { latLngFromViewport, visibleTiles } from "../src/options/location-map";
import { NO_TILES, TileFailures } from "../src/options/tile-provider";

const start = { x: 100, y: 100 };
function model(editable = true) {
  const m = new LocationMapModel();
  m.reset({ latitude: 35, longitude: 139 }, 6, editable);
  return m;
}
describe("location picker state", () => {
  it("pans without selecting, including automatic preview", () => {
    for (const editable of [true, false]) {
      const m = model(editable);
      m.begin(1, "pan", start);
      m.move(1, { x: 180, y: 110 });
      m.end(1, { x: 180, y: 110 });
      expect(m.selection).toEqual({ latitude: 35, longitude: 139 });
      expect(m.viewport.center.longitude).not.toBe(139);
    }
  });
  it("selects on a click with jitter, only in manual mode", () => {
    const m = model();
    const center = { ...m.viewport.center };
    m.begin(1, "pan", start);
    m.move(1, { x: 103, y: 102 });
    expect(m.viewport.center).toEqual(center);
    expect(m.end(1, { x: 103, y: 102 })).toBe(true);
    expect(m.selection).not.toEqual(center);
    m.editable = false;
    const before = m.selection;
    m.begin(1, "pan", start);
    expect(m.end(1, start)).toBe(false);
    expect(m.selection).toEqual(before);
  });
  it("a drag returning to its origin never becomes a click", () => {
    const m = model();
    m.begin(1, "pan", start);
    m.move(1, { x: 150, y: 100 });
    expect(m.end(1, start)).toBe(false);
    expect(m.selection).toEqual({ latitude: 35, longitude: 139 });
  });
  it("marker drag selects without panning and ignores other pointers", () => {
    const m = model();
    m.begin(1, "marker", start);
    expect(m.move(2, { x: 200, y: 200 })).toBe(false);
    expect(m.begin(2, "pan", start)).toBe(false);
    expect(m.move(1, { x: 200, y: 200 })).toBe(true);
    expect(m.viewport.center).toEqual({ latitude: 35, longitude: 139 });
    expect(m.selection).not.toEqual(m.viewport.center);
  });
  it("cancel, blur and lost capture can end a gesture without selecting", () => {
    const m = model();
    m.begin(1, "pan", start);
    m.cancel();
    expect(m.end(1, start)).toBe(false);
    expect(m.selection).toEqual({ latitude: 35, longitude: 139 });
    expect(m.begin(2, "pan", start)).toBe(true);
  });
  it("zoom preserves the geographic point under the pointer and selection", () => {
    const m = model();
    const point = latLngFromViewport(m.viewport, start);
    m.zoom(1, start);
    const after = latLngFromViewport(m.viewport, start);
    expect(after.latitude).toBeCloseTo(point.latitude, 8);
    expect(after.longitude).toBeCloseTo(point.longitude, 8);
    expect(m.selection).toEqual({ latitude: 35, longitude: 139 });
  });
  it("typed / GeoIP selection explicitly recenters and preserves poles in fields", () => {
    const m = model();
    m.select({ latitude: 90, longitude: 180 }, true);
    expect(m.selection).toEqual({ latitude: 90, longitude: 180 });
    expect(m.viewport.center.latitude).toBeLessThan(86);
    m.select({ latitude: -20, longitude: -180 }, true);
    expect(m.viewport.center).toEqual({ latitude: -20, longitude: -180 });
  });
  it("profile reset drops pointer state, old selection and zoom without a GeoIP seed", () => {
    const m = model();
    m.begin(1, "marker", start);
    m.reset(null, 2, false);
    expect(m.interaction).toBeNull();
    expect(m.selection).toBeNull();
    expect(m.viewport.zoom).toBe(2);
  });
  it("rejects malformed coordinates and ignores invalid dimensions", () => {
    const m = model();
    m.select({ latitude: NaN, longitude: 10 });
    expect(m.selection).toBeNull();
    m.select({ latitude: 0, longitude: 181 });
    expect(m.selection).toBeNull();
    m.resize(0, NaN);
    expect(m.viewport.width).toBe(640);
    m.resize(800, 320);
    expect(m.viewport.height).toBe(320);
  });
  it("marker arrow movement follows the key direction without moving the viewport", () => {
    const m = model();
    m.nudge(32, 0, true); // ArrowLeft
    expect(m.selection?.longitude).toBeLessThan(139);
    m.nudge(0, 32, true); // ArrowUp
    expect(m.selection?.latitude).toBeGreaterThan(35);
    expect(m.viewport.center).toEqual({ latitude: 35, longitude: 139 });
  });
  it("resizing preserves viewport center, zoom and geographic selection", () => {
    const m = model();
    m.resize(1000, 500);
    expect(m.viewport).toMatchObject({
      width: 1000,
      height: 500,
      zoom: 6,
      center: { latitude: 35, longitude: 139 },
    });
    expect(m.selection).toEqual({ latitude: 35, longitude: 139 });
  });
  it("cancelled marker gestures ignore late moves and pointerup", () => {
    const m = model();
    m.begin(1, "marker", start);
    m.cancel();
    expect(m.move(1, { x: 200, y: 200 })).toBe(false);
    expect(m.end(1, { x: 200, y: 200 })).toBe(false);
    expect(m.selection).toEqual({ latitude: 35, longitude: 139 });
  });
});
describe("tile privacy and failure contract", () => {
  it("ships a named no-network provider, visible attribution and offline selection", () => {
    expect(NO_TILES.id).toBe("none");
    expect(NO_TILES.attribution).toContain("No map imagery");
    expect(NO_TILES.privacy).toContain("No location or map requests");
    const m = model();
    expect(visibleTiles(m.viewport)).toEqual([]);
    m.begin(1, "pan", start);
    expect(m.end(1, start)).toBe(true);
    expect(m.selection).not.toBeNull();
  });
  it("negatively caches failures with exponential backoff and clears success", () => {
    let now = 100;
    const failures = new TileFailures(() => now);
    failures.fail("tile");
    for (let i = 0; i < 100; i++) expect(failures.allows("tile")).toBe(false);
    now += 30_000;
    expect(failures.allows("tile")).toBe(true);
    failures.fail("tile");
    now += 30_000;
    expect(failures.allows("tile")).toBe(false);
    now += 30_000;
    expect(failures.allows("tile")).toBe(true);
    failures.fail("tile");
    failures.success("tile");
    expect(failures.allows("tile")).toBe(true);
  });
  it("bounds negative-cache memory and caps retry delay at five minutes", () => {
    let now = 1;
    const failures = new TileFailures(() => now);
    for (let i = 0; i < 20; i++) failures.fail("repeated");
    now += 299_999;
    expect(failures.allows("repeated")).toBe(false);
    now++;
    expect(failures.allows("repeated")).toBe(true);
    for (let i = 0; i < 257; i++) failures.fail(`tile-${i}`);
    expect(failures.allows("tile-0")).toBe(true);
    expect(failures.allows("tile-256")).toBe(false);
  });
});
