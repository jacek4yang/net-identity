/**
 * Per-tab, per-frame page-shim diagnostics.
 *
 * These records are untrusted self-reports. They never become the identity.
 * The active tab is only a display preference: one current frame does not make
 * the other frames current.
 */
import type { ContentRuntimeState } from "./state";

export const MAX_CONTENT_DIAGNOSTICS = 64;

export interface ContentDiagnostic {
  tabId: number;
  frameId: number;
  generation: number;
  timezone: string | null;
  updatedAt: number;
}

export interface ContentProbeResult {
  frames: ContentDiagnostic[];
  activeTabId: number | null;
}

export function contentDiagnosticKey(tabId: number, frameId: number): string {
  return `${tabId}:${frameId}`;
}

/** Replaces the same tab and frame, then drops the oldest records past the cap. */
export function recordContentDiagnostic(
  entries: readonly ContentDiagnostic[],
  next: ContentDiagnostic,
  limit = MAX_CONTENT_DIAGNOSTICS,
): ContentDiagnostic[] {
  const key = contentDiagnosticKey(next.tabId, next.frameId);
  const combined = [
    ...entries.filter((entry) => contentDiagnosticKey(entry.tabId, entry.frameId) !== key),
    next,
  ].sort((left, right) => left.updatedAt - right.updatedAt || left.tabId - right.tabId);
  return combined.slice(Math.max(0, combined.length - limit));
}

export function forgetContentTab(
  entries: readonly ContentDiagnostic[],
  tabId: number,
): ContentDiagnostic[] {
  return entries.filter((entry) => entry.tabId !== tabId);
}

export function frameMatchesIdentity(
  entry: ContentDiagnostic,
  generation: number,
  timezone: string | undefined,
): boolean {
  if (entry.generation !== generation) return false;
  if (timezone === undefined) return entry.timezone === null;
  return entry.timezone === timezone;
}

export function summarizeContentDiagnostics(
  entries: readonly ContentDiagnostic[],
  generation: number,
  timezone: string | undefined,
  activeTabId: number | null,
): ContentRuntimeState {
  const current = entries.filter((entry) => frameMatchesIdentity(entry, generation, timezone));
  const active =
    activeTabId === null
      ? undefined
      : entries.find((entry) => entry.tabId === activeTabId && entry.frameId === 0);
  const preferred = active ?? entries[entries.length - 1];
  return {
    hasShim: entries.length > 0,
    reportedGeneration: preferred?.generation ?? null,
    ...(preferred?.timezone === undefined || preferred.timezone === null
      ? {}
      : { reportedTimezone: preferred.timezone }),
    frameCount: entries.length,
    currentFrameCount: current.length,
    activeTabId,
    activeTabCurrent: active !== undefined && frameMatchesIdentity(active, generation, timezone),
  };
}
