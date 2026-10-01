/** Locally bundled renderer. All remote data passes through the background broker. */
import { Map as LibreMap, addProtocol, removeProtocol, setWorkerUrl } from "maplibre-gl";
import { extensionUrl, request } from "../shared/runtime";
import {
  isMapResourceUrl,
  MAP_STYLE_URL,
  mapFailureMustStop,
  parseMapResponse,
} from "../shared/map-provider";
import { isPlainObject } from "../shared/result";
import { mapLibreCamera, type MapViewport } from "./location-map";

export interface OnlineMap {
  update(viewport: MapViewport): void;
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
  addProtocol(protocol, async (parameters, abortController) => {
    const url = parameters.url.replace(`${protocol}://`, "https://");
    if (!isMapResourceUrl(url)) throw new Error("Unapproved map resource.");
    const requestId = crypto.randomUUID();
    const cancel = () => {
      void request({ type: "map:cancel", sessionId, requestId }, parseMapResponse);
    };
    abortController.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (disposed || abortController.signal.aborted) throw new Error("Map closed.");
      const result = await request(
        { type: "map:fetch", sessionId, requestId, url },
        parseMapResponse,
      );
      if (disposed || abortController.signal.aborted)
        throw new DOMException("Map request cancelled.", "AbortError");
      if (!result.ok || !result.value.ok || result.value.data === undefined) {
        if (
          !result.ok ||
          (result.value.ok ? result.value.data === undefined : result.value.kind === "blocked")
        )
          onError(true);
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
      abortController.signal.removeEventListener("abort", cancel);
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
      maxTileCacheSize: 64,
      transformConstrain: (center, zoom) => ({ center, zoom }),
      minZoom: -1,
      maxZoom: 17,
      renderWorldCopies: true,
      fadeDuration: 0,
      canvasContextAttributes: { preserveDrawingBuffer: false },
      transformRequest: (url) => {
        if (!isMapResourceUrl(url)) throw new Error("Unapproved map resource.");
        return { url: url.replace("https://", `${protocol}://`) };
      },
    });
  } catch (error) {
    removeProtocol(protocol);
    container.replaceChildren();
    throw error;
  }
  renderer.on("error", () => {
    if (!disposed) onError(mapFailureMustStop(loaded, "unavailable"));
  });
  renderer.on("load", () => {
    loaded = true;
    if (!disposed) onReady();
  });
  renderer.getCanvas().addEventListener("webglcontextlost", () => {
    if (!disposed) onError(true);
  });
  renderer.getCanvas().setAttribute("aria-hidden", "true");
  renderer.getCanvas().tabIndex = -1;
  return {
    update(next) {
      if (disposed) return;
      renderer.resize();
      renderer.jumpTo(mapLibreCamera(next));
    },
    remove() {
      if (disposed) return;
      disposed = true;
      renderer.remove();
      removeProtocol(protocol);
      container.replaceChildren();
    },
  };
}
