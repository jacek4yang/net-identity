/** Image-only providers. Adding a network provider requires policy/privacy review. */
export interface TileProvider {
  readonly id: string;
  readonly attribution: string;
  readonly privacy: string;
  url(zoom: number, x: number, y: number): string | null;
}

/** Production uses a local coordinate grid: no Referer spoofing or third-party requests. */
export const NO_TILES: TileProvider = {
  id: "none",
  attribution: "Local coordinate grid · No map imagery",
  privacy: "No location or map requests leave this page.",
  url: () => null,
};

/** Failed images cannot be recreated on every pointermove/resize. Bounded per-page cache. */
export class TileFailures {
  private readonly failures = new Map<string, { until: number; attempts: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  allows(url: string): boolean {
    return (this.failures.get(url)?.until ?? 0) <= this.now();
  }
  fail(url: string): void {
    const attempts = (this.failures.get(url)?.attempts ?? 0) + 1;
    this.failures.delete(url);
    this.failures.set(url, {
      attempts,
      until: this.now() + Math.min(300_000, 30_000 * 2 ** Math.min(attempts - 1, 4)),
    });
    if (this.failures.size > 256) {
      const oldest = this.failures.keys().next().value;
      if (oldest !== undefined) this.failures.delete(oldest);
    }
  }
  success(url: string): void {
    this.failures.delete(url);
  }
}
