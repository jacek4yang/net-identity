import {
  clampLatitude,
  clampLongitude,
  latLngFromViewport,
  panViewport,
  worldPoint,
  latLngFromWorld,
  type MapLatLng,
  type MapPoint,
  type MapViewport,
} from "./location-map";

export const CLICK_THRESHOLD = 6;
interface Interaction {
  id: number;
  kind: "pan" | "marker";
  start: MapPoint;
  last: MapPoint;
  moved: boolean;
}

/** All coordinates are CSS pixels; device pixel ratio never changes the projection. */
export class LocationMapModel {
  viewport: MapViewport = {
    width: 640,
    height: 280,
    zoom: 2,
    center: { latitude: 20, longitude: 0 },
  };
  selection: MapLatLng | null = null;
  editable = false;
  interaction: Interaction | null = null;

  select(point: MapLatLng | null, recenter = false): void {
    this.selection =
      point !== null &&
      Number.isFinite(point.latitude) &&
      Math.abs(point.latitude) <= 90 &&
      Number.isFinite(point.longitude) &&
      Math.abs(point.longitude) <= 180
        ? { ...point }
        : null;
    if (recenter && this.selection !== null)
      this.viewport.center = {
        latitude: clampLatitude(this.selection.latitude),
        longitude: this.selection.longitude,
      };
  }

  reset(point: MapLatLng | null, zoom: number, editable: boolean): void {
    this.cancel();
    this.editable = editable;
    this.viewport.center = { latitude: 20, longitude: 0 };
    this.viewport.zoom = Math.max(0, Math.min(18, Number.isFinite(zoom) ? Math.round(zoom) : 2));
    this.select(point, true);
  }

  resize(width: number, height: number): void {
    if (Number.isFinite(width) && width > 0) this.viewport.width = width;
    if (Number.isFinite(height) && height > 0) this.viewport.height = height;
  }

  begin(id: number, kind: "pan" | "marker", point: MapPoint): boolean {
    if (this.interaction !== null || (kind === "marker" && !this.editable)) return false;
    this.interaction = { id, kind, start: point, last: point, moved: false };
    return true;
  }

  move(id: number, point: MapPoint): boolean {
    const drag = this.interaction;
    if (drag === null || drag.id !== id) return false;
    if (Math.hypot(point.x - drag.start.x, point.y - drag.start.y) > CLICK_THRESHOLD)
      drag.moved = true;
    if (!drag.moved) return false;
    if (drag.kind === "pan")
      this.viewport.center = panViewport(
        this.viewport,
        point.x - drag.last.x,
        point.y - drag.last.y,
      );
    else this.select(latLngFromViewport(this.viewport, point));
    drag.last = point;
    return drag.kind === "marker";
  }

  end(id: number, point: MapPoint): boolean {
    const drag = this.interaction;
    if (drag === null || drag.id !== id) return false;
    const selected = this.move(id, point);
    this.interaction = null;
    if (drag.kind === "pan" && !drag.moved && this.editable) {
      this.select(latLngFromViewport(this.viewport, point));
      return true;
    }
    return selected;
  }

  cancel(): void {
    this.interaction = null;
  }

  zoom(
    delta: number,
    anchor: MapPoint = { x: this.viewport.width / 2, y: this.viewport.height / 2 },
  ): void {
    if (!Number.isFinite(delta)) return;
    const point = latLngFromViewport(this.viewport, anchor);
    const zoom = Math.max(0, Math.min(18, this.viewport.zoom + Math.sign(delta)));
    const projected = worldPoint(point.latitude, point.longitude, zoom);
    this.viewport = {
      ...this.viewport,
      zoom,
      center: latLngFromWorld(
        {
          x: projected.x - anchor.x + this.viewport.width / 2,
          y: projected.y - anchor.y + this.viewport.height / 2,
        },
        zoom,
      ),
    };
  }

  nudge(dx: number, dy: number, selection = false): void {
    if (selection && this.editable && this.selection !== null) {
      const point = worldPoint(
        this.selection.latitude,
        this.selection.longitude,
        this.viewport.zoom,
      );
      this.select(latLngFromWorld({ x: point.x + dx, y: point.y + dy }, this.viewport.zoom));
    } else this.viewport.center = panViewport(this.viewport, dx, dy);
    this.viewport.center.longitude = clampLongitude(this.viewport.center.longitude);
  }
}
