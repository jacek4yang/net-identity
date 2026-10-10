/** Locally bundled renderer. All remote data passes through the background broker. */
import { Map as LibreMap, addProtocol, removeProtocol, setWorkerUrl } from "maplibre-gl";
import { extensionUrl, request } from "../shared/runtime";
import {
  isMapResourceUrl,
  MAP_STYLE_URL,
  mapFailureMustStop,
  parseMapResponse,
  type MapFailureKind,
} from "../shared/map-provider";
import { isPlainObject } from "../shared/result";
import { mapLibreCamera, type MapViewport } from "./location-map";
import { MapRequestQueue } from "./map-request-queue";

export interface OnlineMap {
  update(viewport: MapViewport): void;
  reload(): void;
  remove(): void;
}

export function createOnlineMap(
  container: HTMLElement,
  sessionId: string,
  viewport: MapViewport,
  onError: (fatal: boolean) => void,
  onReady: () => void,
): OnlineMap {
  const protocol = `ni-map-${sessionId}`;
  let disposed = false;
  let loaded = false;
  let failed = false;
  let reportedReady = false;
  let revision = 0;
  const queue = new MapRequestQueue();
  const reportFailure = (kind: MapFailureKind) => {
    if (disposed) return;
    failed = true;
    onError(mapFailureMustStop(loaded, kind));
  };
  addProtocol(protocol, async (parameters, abortController) => {
    const requestRevision = revision;
    let failureKind: MapFailureKind = "unavailable";
    try {
      const url = parameters.url.replace(`${protocol}://`, "https://");
      if (!isMapResourceUrl(url)) {
        failureKind = "blocked";
        throw new Error("Unapproved map resource.");
      }
      return await queue.run(abortController.signal, async (signal) => {
        if (disposed || signal.aborted) throw new DOMException("Map closed.", "AbortError");
        const requestId = crypto.randomUUID();
        const cancel = () => {
          void request({ type: "map:cancel", sessionId, requestId }, parseMapResponse);
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          const result = await request(
            { type: "map:fetch", sessionId, requestId, url },
            parseMapResponse,
          );
          if (disposed || signal.aborted)
            throw new DOMException("Map request cancelled.", "AbortError");
          if (!result.ok || !result.value.ok || result.value.data === undefined) {
            failureKind = !result.ok || result.value.ok ? "blocked" : result.value.kind;
            throw new Error("Map data unavailable.");
          }
          const data = result.value.data;
          if (parameters.type === "json") {
            const json: unknown = JSON.parse(new TextDecoder().decode(data));
            if (!isPlainObject(json)) throw new Error("Invalid map data.");
            // Attribution is authored locally, never arbitrary provider HTML.
            delete json.attribution;
            return { data: json };
          }
          return { data };
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      });
    } catch (error) {
      // MapLibre can catch a glyph error and substitute a local missing glyph.
      // Report genuine data failures here, before that fallback hides the error.
      if (
        requestRevision === revision &&
        !abortController.signal.aborted &&
        !(error instanceof DOMException && error.name === "AbortError")
      )
        reportFailure(failureKind);
      throw error;
    }
  });
  setWorkerUrl(extensionUrl("options/maplibre-worker.js"));
  let renderer: LibreMap;
  try {
    renderer = new LibreMap({
      container,
      style: MAP_STYLE_URL,
      ...mapLibreCamera(viewport),
      interactive: false,
      attributionControl: false,
      // Use the style's brokered glyph data, even on systems without CJK fonts.
      localIdeographFontFamily: false,
      maxTileCacheSize: 64,
      transformConstrain: (center, zoom) => ({ center, zoom }),
      minZoom: -1,
      maxZoom: 17,
      renderWorldCopies: true,
      fadeDuration: 0,
      canvasContextAttributes: { preserveDrawingBuffer: false },
      transformRequest: (url) => {
        if (!isMapResourceUrl(url)) {
          reportFailure("blocked");
          throw new Error("Unapproved map resource.");
        }
        return { url: url.replace("https://", `${protocol}://`) };
      },
    });
  } catch (error) {
    disposed = true;
    queue.dispose();
    removeProtocol(protocol);
    container.replaceChildren();
    throw error;
  }
  renderer.on("error", () => {
    reportFailure("unavailable");
  });
  const notifyReady = () => {
    loaded = true;
    if (!disposed && !failed && !reportedReady) {
      reportedReady = true;
      onReady();
    }
  };
  renderer.on("load", notifyReady);
  renderer.on("idle", notifyReady);
  renderer.getCanvas().addEventListener("webglcontextlost", () => {
    reportFailure("blocked");
  });
  renderer.getCanvas().setAttribute("aria-hidden", "true");
  renderer.getCanvas().tabIndex = -1;
  return {
    reload() {
      if (disposed) return;
      ++revision;
      failed = false;
      loaded = false;
      reportedReady = false;
      // Reload data in the live context. Destroy/recreate can race Firefox's
      // asynchronous context disposal, even when only one canvas is visible.
      // Keep the same bounded queue: old RPCs hold their slots until settlement.
      renderer.setStyle(MAP_STYLE_URL, { diff: false });
    },
    update(next) {
      if (disposed) return;
      renderer.resize();
      renderer.jumpTo(mapLibreCamera(next));
    },
    remove() {
      if (disposed) return;
      disposed = true;
      queue.dispose();
      renderer.remove();
      removeProtocol(protocol);
      container.replaceChildren();
    },
  };
}
