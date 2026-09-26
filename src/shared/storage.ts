/**
 * Storage area abstraction.
 *
 * Production code adapts `browser.storage.*` here; tests use plain in-memory
 * implementations. No module below the background wiring touches `browser` directly,
 * which keeps every storage code path unit testable.
 */
export interface StorageAreaLike {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
}

/** Adapts a WebExtension storage area to {@link StorageAreaLike}. */
export function fromBrowserStorageArea(area: browser.storage.StorageArea): StorageAreaLike {
  return {
    get: (keys) => area.get(keys ?? null),
    set: (items) => area.set(items),
    remove: (keys) => area.remove(keys),
    clear: () => area.clear(),
  };
}

export async function readKey(area: StorageAreaLike, key: string): Promise<unknown> {
  const stored = await area.get(key);
  return stored[key];
}
