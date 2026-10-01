/** OpenFreeMap data only. This is not a general-purpose network proxy. */
import { fail, isPlainObject, ok, type Result } from "./result";

export const MAP_ORIGIN = "https://tiles.openfreemap.org";
export const MAP_STYLE_URL = `${MAP_ORIGIN}/styles/liberty`;
export const MAX_MAP_RESOURCE_BYTES = 4 * 1024 * 1024;

/** Inspected official Liberty resources; no credentials, query, fragment or other origins. */
export function isMapResourceUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== MAP_ORIGIN || url.username || url.password || url.search || url.hash)
    return false;
  const path = url.pathname;
  if (path.startsWith("/fonts/")) {
    const match = /^\/fonts\/([^/]+)\/\d{1,7}-\d{1,7}\.pbf$/.exec(path);
    if (match?.[1] === undefined) return false;
    try {
      return (
        /^[A-Za-z0-9_,. -]+$/.test(decodeURIComponent(match[1])) &&
        !decodeURIComponent(match[1]).includes("..")
      );
    } catch {
      return false;
    }
  }
  return (
    path === "/styles/liberty" ||
    path === "/planet" ||
    /^\/planet\/\d{8}_\d{6}_pt\/\d{1,2}\/\d{1,6}\/\d{1,6}\.pbf$/.test(path) ||
    /^\/natural_earth\/ne2sr\/[0-6]\/\d{1,2}\/\d{1,2}\.png$/.test(path) ||
    /^\/sprites\/ofm_[a-z0-9]+\/ofm(?:@2x)?\.(?:json|png)$/.test(path)
  );
}

export type MapRequest =
  | { type: "map:open"; generation: number }
  | { type: "map:fetch"; sessionId: string; requestId: string; url: string }
  | { type: "map:cancel"; sessionId: string; requestId: string }
  | { type: "map:close"; sessionId: string };
export type MapFailureKind = "blocked" | "unavailable";
export type MapResponse =
  | { ok: true; sessionId?: string; data?: ArrayBuffer }
  | { ok: false; error: string; kind: MapFailureKind };

/** Never keep rendering after route/consent invalidation; partial network errors may keep known tiles. */
export function mapFailureMustStop(loaded: boolean, kind: MapFailureKind): boolean {
  return !loaded || kind === "blocked";
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);
}
export function parseMapRequest(value: unknown): Result<MapRequest> {
  if (!isPlainObject(value)) return fail("Invalid map request.");
  if (
    value.type === "map:open" &&
    Number.isSafeInteger(value.generation) &&
    typeof value.generation === "number" &&
    value.generation >= 0
  )
    return ok({ type: value.type, generation: value.generation });
  if (!validId(value.sessionId)) return fail("Invalid map session.");
  if (value.type === "map:close") return ok({ type: value.type, sessionId: value.sessionId });
  if (!validId(value.requestId)) return fail("Invalid map request id.");
  if (value.type === "map:cancel")
    return ok({ type: value.type, sessionId: value.sessionId, requestId: value.requestId });
  if (value.type === "map:fetch" && isMapResourceUrl(value.url))
    return ok({
      type: value.type,
      sessionId: value.sessionId,
      requestId: value.requestId,
      url: value.url,
    });
  return fail("Map resource is not permitted.");
}
export function parseMapResponse(value: unknown): Result<MapResponse> {
  if (!isPlainObject(value)) return fail("Invalid map response.");
  if (value.ok === false && typeof value.error === "string" && value.error.length <= 300)
    return value.kind === undefined || value.kind === "blocked" || value.kind === "unavailable"
      ? ok({ ok: false, error: value.error, kind: value.kind ?? "blocked" })
      : fail("Invalid map failure.");
  if (
    value.ok !== true ||
    (value.sessionId !== undefined && !validId(value.sessionId)) ||
    (value.data !== undefined &&
      (!(value.data instanceof ArrayBuffer) || value.data.byteLength > MAX_MAP_RESOURCE_BYTES))
  )
    return fail("Invalid map response.");
  return ok({
    ok: true,
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    ...(value.data instanceof ArrayBuffer ? { data: value.data } : {}),
  });
}
