/**
 * Local map maths for the manual location picker.
 *
 * The picker is a Web Mercator plane with a local coordinate grid. A tile
 * provider can supply optional image decoration after policy/privacy review.
 * Online decoration is explicitly enabled and fetched by a separate background broker.
 */

import { NO_TILES, type TileProvider } from "./tile-provider";
export const MAP_TILE_SIZE = 256;
/** Web Mercator is undefined at the poles. */
export const MAP_MAX_LATITUDE = 85.05112878;

export interface MapPoint {
  x: number;
  y: number;
}

export interface MapLatLng {
  latitude: number;
  longitude: number;
}

export interface MapViewport {
  width: number;
  height: number;
  zoom: number;
  center: MapLatLng;
}

export function clampLatitude(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAP_MAX_LATITUDE, Math.max(-MAP_MAX_LATITUDE, value));
}

export function clampLongitude(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value >= -180 && value <= 180) return value;
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

export function worldSize(zoom: number): number {
  return MAP_TILE_SIZE * 2 ** zoom;
}

export function worldPoint(latitude: number, longitude: number, zoom: number): MapPoint {
  const size = worldSize(zoom);
  const lat = clampLatitude(latitude);
  const lng = clampLongitude(longitude);
  const sine = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * size,
  };
}

export function latLngFromWorld(point: MapPoint, zoom: number): MapLatLng {
  const size = worldSize(zoom);
  const longitude = clampLongitude((point.x / size) * 360 - 180);
  const mercator = Math.PI * (1 - (2 * point.y) / size);
  const latitude = clampLatitude((180 / Math.PI) * Math.atan(Math.sinh(mercator)));
  return { latitude, longitude };
}

export function viewportPoint(
  viewport: MapViewport,
  latitude: number,
  longitude: number,
): MapPoint {
  const size = worldSize(viewport.zoom);
  const center = worldPoint(viewport.center.latitude, viewport.center.longitude, viewport.zoom);
  const target = worldPoint(latitude, longitude, viewport.zoom);
  let dx = target.x - center.x;
  while (dx > size / 2) dx -= size;
  while (dx < -size / 2) dx += size;
  return {
    x: viewport.width / 2 + dx,
    y: viewport.height / 2 + (target.y - center.y),
  };
}

export function latLngFromViewport(viewport: MapViewport, point: MapPoint): MapLatLng {
  const center = worldPoint(viewport.center.latitude, viewport.center.longitude, viewport.zoom);
  return latLngFromWorld(
    {
      x: center.x + (point.x - viewport.width / 2),
      y: center.y + (point.y - viewport.height / 2),
    },
    viewport.zoom,
  );
}

/** Tile URL for decoration. Returns null when the indexes are outside the zoom. */
export function mapTileUrl(
  zoom: number,
  x: number,
  y: number,
  provider: TileProvider = NO_TILES,
): string | null {
  const limit = 2 ** zoom;
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 19) return null;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (x < 0 || y < 0 || x >= limit || y >= limit) return null;
  return provider.url(zoom, x, y);
}

/** Equatorial circumference used only to size the accuracy circle. */
const EARTH_CIRCUMFERENCE_METRES = 40_075_016.686;

function metresPerPixel(latitude: number, zoom: number): number {
  const cosine = Math.cos((clampLatitude(latitude) * Math.PI) / 180);
  return (EARTH_CIRCUMFERENCE_METRES * Math.max(cosine, 0.01)) / worldSize(zoom);
}

/** Pixel radius of an accuracy circle at this latitude and zoom. Zero when accuracy is unusable. */
export function accuracyRadiusPixels(
  latitude: number,
  accuracyMeters: number,
  zoom: number,
): number {
  if (!Number.isFinite(accuracyMeters) || accuracyMeters <= 0) return 0;
  if (!Number.isInteger(zoom) || zoom < 0) return 0;
  const metres = metresPerPixel(latitude, zoom);
  if (metres <= 0) return 0;
  return accuracyMeters / metres;
}

/**
 * Zoom that fits the accuracy diameter into about 45% of the viewport height.
 * Falls back to a world view when accuracy is missing.
 */
export function zoomToFitAccuracy(
  latitude: number,
  accuracyMeters: number,
  viewportHeight: number,
): number {
  const fallback = 4;
  if (!Number.isFinite(accuracyMeters) || accuracyMeters <= 0) return fallback;
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return fallback;
  const targetDiameter = Math.max(48, viewportHeight * 0.45);
  const resolution = (accuracyMeters * 2) / targetDiameter;
  const cosine = Math.cos((clampLatitude(latitude) * Math.PI) / 180);
  const size = (EARTH_CIRCUMFERENCE_METRES * Math.max(cosine, 0.01)) / resolution;
  const zoom = Math.log2(size / MAP_TILE_SIZE);
  if (!Number.isFinite(zoom)) return fallback;
  return Math.min(16, Math.max(2, Math.round(zoom)));
}

/** New centre after the map is dragged by `(deltaX, deltaY)` pixels. */
export function panViewport(viewport: MapViewport, deltaX: number, deltaY: number): MapLatLng {
  return latLngFromViewport(viewport, {
    x: viewport.width / 2 - deltaX,
    y: viewport.height / 2 - deltaY,
  });
}

export interface PlacedTile {
  url: string;
  left: number;
  top: number;
}

/** How many tiles are needed on each side of the centre tile to cover this extent. */
export function tileRadius(viewportExtent: number): number {
  if (!Number.isFinite(viewportExtent) || viewportExtent <= 0) return 1;
  return Math.max(1, Math.ceil(viewportExtent / 2 / MAP_TILE_SIZE));
}

function wrapTileX(x: number, zoom: number): number {
  const limit = 2 ** zoom;
  return ((x % limit) + limit) % limit;
}

/**
 * Image tiles covering the viewport. Indexes past the poles are omitted so a
 * failed or missing tile never blocks the coordinate grid underneath.
 */
export function visibleTiles(
  viewport: MapViewport,
  provider: TileProvider = NO_TILES,
): PlacedTile[] {
  const center = worldPoint(viewport.center.latitude, viewport.center.longitude, viewport.zoom);
  const originX = Math.floor(center.x / MAP_TILE_SIZE);
  const originY = Math.floor(center.y / MAP_TILE_SIZE);
  const spanX = tileRadius(viewport.width);
  const spanY = tileRadius(viewport.height);
  const tiles: PlacedTile[] = [];
  for (let dx = -spanX; dx <= spanX; dx += 1) {
    for (let dy = -spanY; dy <= spanY; dy += 1) {
      const url = mapTileUrl(
        viewport.zoom,
        wrapTileX(originX + dx, viewport.zoom),
        originY + dy,
        provider,
      );
      if (url === null) continue;
      const left = (originX + dx) * MAP_TILE_SIZE - center.x + viewport.width / 2;
      const top = (originY + dy) * MAP_TILE_SIZE - center.y + viewport.height / 2;
      if (
        left >= viewport.width ||
        top >= viewport.height ||
        left + MAP_TILE_SIZE <= 0 ||
        top + MAP_TILE_SIZE <= 0
      )
        continue;
      tiles.push({
        url,
        left: (originX + dx) * MAP_TILE_SIZE - center.x + viewport.width / 2,
        top: (originY + dy) * MAP_TILE_SIZE - center.y + viewport.height / 2,
      });
    }
  }
  return tiles;
}

export interface LocationSeed {
  latitude?: number | undefined;
  longitude?: number | undefined;
  accuracy?: number | undefined;
  timezone?: string | undefined;
}

export interface ManualLocationFields {
  latitude: string;
  longitude: string;
  accuracy: string;
  timezone: string;
}

/** Fills only blank manual fields. A later user edit is left untouched. */
export function seedBlankManualFields(
  fields: ManualLocationFields,
  seed: LocationSeed | null,
  userEdited: boolean,
): ManualLocationFields {
  if (userEdited || seed === null) return fields;
  return {
    latitude:
      fields.latitude.trim() === "" && seed.latitude !== undefined
        ? String(seed.latitude)
        : fields.latitude,
    longitude:
      fields.longitude.trim() === "" && seed.longitude !== undefined
        ? String(seed.longitude)
        : fields.longitude,
    accuracy:
      fields.accuracy.trim() === "" && seed.accuracy !== undefined
        ? String(seed.accuracy)
        : fields.accuracy,
    timezone:
      fields.timezone.trim() === "" && seed.timezone !== undefined
        ? seed.timezone
        : fields.timezone,
  };
}

/** Explicit "Use GeoIP location" action. Replaces the manual point. */
export function applyResolvedLocation(
  fields: ManualLocationFields,
  seed: LocationSeed,
): ManualLocationFields {
  return {
    latitude: seed.latitude === undefined ? fields.latitude : String(seed.latitude),
    longitude: seed.longitude === undefined ? fields.longitude : String(seed.longitude),
    accuracy: seed.accuracy === undefined ? fields.accuracy : String(seed.accuracy),
    timezone: seed.timezone === undefined ? fields.timezone : seed.timezone,
  };
}

/** Keep the renderer on the exact same Mercator plane as our 256px interaction model. */
export function mapLibreCamera(viewport: MapViewport): { center: [number, number]; zoom: number } {
  return { center: [viewport.center.longitude, viewport.center.latitude], zoom: viewport.zoom - 1 };
}
