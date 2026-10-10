/** Validate the complete source region and return its uniform output scale.
 * Store artwork stays 1280x800. Taller complete regions may be reduced to at
 * least 75%. Never crop controls or enlarge rasterized pixels.
 */
export function captureFrameScale(frame, bounds, viewport) {
  if (frame !== "picker" && frame !== "audit") return null;
  const { x, y, width, height } = bounds;
  if (![x, y, width, height, viewport.width, viewport.height].every(Number.isFinite)) return null;
  if (viewport.width !== 1280 || viewport.height < 800 || viewport.height > 1200) return null;
  if (
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > viewport.width ||
    y + height > viewport.height
  )
    return null;
  const margin = frame === "picker" ? 8 : 16;
  const scale = Math.min(1, (1280 - margin * 2) / width, (800 - margin * 2) / height);
  return scale >= 0.75 ? scale : null;
}
