/** Native-pixel crop bounds; the whole real UI region must already be visible. */
export function captureFrameFits(frame, bounds, viewport) {
  if (frame !== "picker" && frame !== "audit") return false;
  const { x, y, width, height } = bounds;
  if (![x, y, width, height, viewport.width, viewport.height].every(Number.isFinite)) return false;
  if (viewport.width !== 1280 || viewport.height !== 800) return false;
  const margin = frame === "picker" ? 8 : 16;
  return (
    x >= 0 &&
    y >= 0 &&
    width > 0 &&
    height > 0 &&
    x + width <= viewport.width &&
    y + height <= viewport.height &&
    height <= viewport.height - margin * 2
  );
}
