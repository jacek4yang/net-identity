/**
 * Isolated-world content bridge.
 *
 * Runs at `document_start` in the extension's isolated world and is the only path
 * between the MAIN-world shim and the background script:
 *
 *   MAIN world  --window.postMessage-->  bridge  --runtime.sendMessage-->  background
 *
 * Trust rules:
 *   - Only public identity data ever travels towards the page.
 *   - Messages arriving *from* the page are validated and are limited to two
 *     shapes: "hello" (a request for the current identity) and "applied" (an
 *     untrusted self-report about what the page shim applied). Page-supplied data
 *     is never used as identity input.
 *   - `event.source === window` and the namespaced `source` field are both required.
 */
import { BRIDGE_SOURCE, PAGE_SOURCE } from "../shared/constants";
import {
  parseIdentityResponse,
  parseOutboundMessage,
  type ContentRequest,
} from "../shared/messages";
import {
  createIdentityEnvelope,
  parsePageAnnounce,
  parsePageAppliedReport,
  type IdentityEnvelope,
  type PageAppliedReport,
} from "../shared/public-identity";
import { ok } from "../shared/result";
import { onRuntimeMessage, request } from "../shared/runtime";

// Fail closed until the background answers. A page that asks early must not
// observe the host position while startup is still deciding.
let currentEnvelope: IdentityEnvelope = createIdentityEnvelope(null, true, true);
let pageShimDetected = false;

function postToPage(envelope: IdentityEnvelope): void {
  window.postMessage(envelope, "*");
}

function sendReport(report: PageAppliedReport): void {
  const message: ContentRequest = { type: "content:report", payload: report };
  // Fire and forget: the report is a diagnostic, and failures are not actionable.
  void request(message, () => ok(undefined));
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;

  const announce = parsePageAnnounce(event.data);
  if (announce.ok) {
    pageShimDetected = true;
    postToPage(currentEnvelope);
    return;
  }

  const report = parsePageAppliedReport(event.data);
  if (report.ok) sendReport(report.value);
});

onRuntimeMessage((message) => {
  const parsed = parseOutboundMessage(message);
  if (!parsed.ok) return undefined;

  if (parsed.value.type === "identity:update") {
    currentEnvelope = parsed.value.envelope;
    postToPage(currentEnvelope);
    return undefined;
  }

  if (parsed.value.type === "content:probe") {
    // Answer the background script's staleness probe. Reports what this frame
    // actually applied, which may legitimately be stale after a profile switch.
    return Promise.resolve({
      generation: currentEnvelope.payload === null ? 0 : currentEnvelope.payload.generation,
      timezone:
        currentEnvelope.payload === null ? null : (currentEnvelope.payload.timezone ?? null),
      hasShim: pageShimDetected,
      url: location.href,
    });
  }

  return undefined;
});

// Handshake with the background script, then push the identity to the page. Pages
// that load before this completes are covered by the shim's own retry schedule.
void (async () => {
  const response = await request(
    { type: "content:hello" } satisfies ContentRequest,
    parseIdentityResponse,
  );
  if (!response.ok) return;
  currentEnvelope = response.value.envelope;
  postToPage(currentEnvelope);
})();

export const BRIDGE_CHANNEL = { bridge: BRIDGE_SOURCE, page: PAGE_SOURCE } as const;
