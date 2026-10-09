import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function luminance(hex: string): number {
  const channels = hex.match(/[\da-f]{2}/gi);
  if (channels?.length !== 3) throw new Error(`Expected six-digit color: ${hex}`);
  const linear = channels.map((value) => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const [red = 0, green = 0, blue = 0] = linear;
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  const [lighter = 0, darker = 0] = values;
  return (lighter + 0.05) / (darker + 0.05);
}

describe("readable interface palette", () => {
  for (const page of ["options", "popup"]) {
    const css = readFileSync(`src/${page}/${page}.css`, "utf8");
    const blocks = [...css.matchAll(/:root\s*\{([^}]+)\}/g)];
    for (const [index, block] of blocks.entries()) {
      it(`${page} ${index === 0 ? "light" : "dark"} text meets WCAG AA contrast`, () => {
        const colors = Object.fromEntries(
          [...(block[1] ?? "").matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi)].map((match) => [
            match[1] ?? "",
            match[2] ?? "",
          ]),
        );
        const color = (key: string): string => {
          const value = colors[key];
          if (!value) throw new Error(`Missing palette color: ${key}`);
          return value;
        };
        for (const foreground of ["fg", "fg-dim", "accent", "ok", "warn", "bad"]) {
          expect(contrast(color(foreground), color("bg")), foreground).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(color("accent-fg"), color("accent"))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(color("fg-dim"), color("panel"))).toBeGreaterThanOrEqual(4.5);
      });
    }
    it(`${page} retains visible keyboard focus and honors reduced motion`, () => {
      expect(css).toContain("summary:focus-visible");
      expect(css).toContain("@media (prefers-reduced-motion: no-preference)");
      expect(css).toContain("@media (forced-colors: active)");
    });
  }
});
