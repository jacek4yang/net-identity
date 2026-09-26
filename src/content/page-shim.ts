/**
 * MAIN-world page shim.
 *
 * Runs at `document_start` in the page's own world so it can install the timezone
 * and geolocation shims before any page script captures the originals.
 *
 * Communication happens only through `window.postMessage` with the isolated-world
 * bridge (`bridge.ts`). The MAIN world cannot use `browser.*` APIs, and by design
 * everything in this world is observable by the page:
 *
 *   - only public identity data crosses the channel
 *   - no proxy configuration, host, port, username or password is ever present here
 *   - an identity is applied only when the background script publishes one
 *   - geolocation stays fail-closed until that publication says no profile is active
 *
 * Installation is idempotent: a non-enumerable marker prevents double wrapping if
 * the script is somehow injected twice.
 */
import { BRIDGE_SOURCE, CONTENT_ANNOUNCE_DELAYS_MS, PAGE_SHIM_MARKER } from "../shared/constants";
import {
  createPageAnnounce,
  createPageAppliedReport,
  parseIdentityEnvelope,
  type IdentityEnvelope,
} from "../shared/public-identity";
import { geolocationCommandForEnvelope, installGeolocationShim } from "./geolocation-shim";
import { installTimeZoneShim } from "./timezone-shim";

function start(): void {
  const timeZoneShim = installTimeZoneShim({ date: Date, intl: Intl });
  const geolocationShim = installGeolocationShim();

  let receivedEnvelope = false;
  let appliedGeneration = 0;
  let appliedTimeZone: string | null = null;
  let hasGeolocationOverride = false;

  const postToBridge = (message: unknown): void => {
    // Target origin is deliberately "*": the target is this same window and the
    // payload is public by design. A concrete origin would break sandboxed and
    // opaque-origin documents.
    window.postMessage(message, "*");
  };

  const reportApplied = (): void => {
    postToBridge(
      createPageAppliedReport({
        generation: appliedGeneration,
        timezone: appliedTimeZone,
        hasGeolocationOverride,
      }),
    );
  };

  const applyEnvelope = (envelope: IdentityEnvelope): void => {
    const identity = envelope.payload;
    const command = geolocationCommandForEnvelope(envelope);

    if (command.type === "release") {
      appliedGeneration = 0;
      appliedTimeZone = null;
      hasGeolocationOverride = false;
      timeZoneShim.setTimeZone(null);
      geolocationShim.release();
      reportApplied();
      return;
    }

    if (identity !== null) {
      appliedGeneration = identity.generation;
      if (identity.timezone !== undefined) {
        appliedTimeZone = identity.timezone;
        timeZoneShim.setTimeZone(appliedTimeZone);
      } else if (!envelope.pending) {
        appliedTimeZone = null;
        timeZoneShim.setTimeZone(null);
      }
    } else if (!envelope.pending) {
      appliedGeneration = 0;
      appliedTimeZone = null;
      timeZoneShim.setTimeZone(null);
    }

    switch (command.type) {
      case "position":
        geolocationShim.setPosition(command.target);
        hasGeolocationOverride = true;
        break;
      case "hold":
        // Keep the previous synthetic position until the new identity commits.
        geolocationShim.hold();
        hasGeolocationOverride = geolocationShim.getTarget() !== null;
        break;
      case "unavailable":
        geolocationShim.unavailable();
        hasGeolocationOverride = false;
        break;
    }

    reportApplied();
  };

  window.addEventListener("message", (event: MessageEvent) => {
    // Only messages posted into this same window are considered.
    if (event.source !== window) return;

    const parsed = parseIdentityEnvelope(event.data, BRIDGE_SOURCE);
    if (!parsed.ok) return;

    receivedEnvelope = true;
    applyEnvelope(parsed.value);
  });

  // Announce ourselves and retry a bounded number of times to cover the race where
  // the bridge or the background handshake has not completed yet.
  for (const delay of CONTENT_ANNOUNCE_DELAYS_MS) {
    setTimeout(() => {
      if (!receivedEnvelope) postToBridge(createPageAnnounce());
    }, delay);
  }
}

if (!(PAGE_SHIM_MARKER in window)) {
  Object.defineProperty(window, PAGE_SHIM_MARKER, {
    value: 1,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  start();
}
