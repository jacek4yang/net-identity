import { describe, expect, it } from "vitest";
import {
  forgetContentTab,
  recordContentDiagnostic,
  summarizeContentDiagnostics,
  type ContentDiagnostic,
} from "../src/shared/content-diagnostics";

const frame = (
  tabId: number,
  frameId: number,
  generation: number,
  updatedAt: number,
): ContentDiagnostic => ({
  tabId,
  frameId,
  generation,
  timezone: "Europe/Amsterdam",
  updatedAt,
});

describe("content diagnostics", () => {
  it("keeps every frame and does not let the active tab hide a stale one", () => {
    let entries: ContentDiagnostic[] = [];
    entries = recordContentDiagnostic(entries, frame(1, 0, 4, 1));
    entries = recordContentDiagnostic(entries, frame(1, 1, 3, 2));
    entries = recordContentDiagnostic(entries, frame(2, 0, 4, 3));

    const summary = summarizeContentDiagnostics(entries, 4, "Europe/Amsterdam", 2);
    expect(summary.frameCount).toBe(3);
    expect(summary.currentFrameCount).toBe(2);
    expect(summary.activeTabCurrent).toBe(true);
    expect(summary.reportedGeneration).toBe(4);
  });

  it("replaces the same frame, drops a closed tab, and caps the log", () => {
    let entries = [frame(1, 0, 1, 1)];
    entries = recordContentDiagnostic(entries, frame(1, 0, 2, 2));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.generation).toBe(2);

    entries = recordContentDiagnostic(entries, frame(3, 0, 2, 3));
    entries = forgetContentTab(entries, 1);
    expect(entries.map((entry) => entry.tabId)).toEqual([3]);

    let capped: ContentDiagnostic[] = [];
    for (let index = 0; index < 5; index += 1) {
      capped = recordContentDiagnostic(capped, frame(index, 0, 1, index), 3);
    }
    expect(capped.map((entry) => entry.tabId)).toEqual([2, 3, 4]);
  });
});
