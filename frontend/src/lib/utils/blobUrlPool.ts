/** Delay before revoking an unused blob URL (keeps images warm across SPA navigation). */
export const BLOB_URL_EVICT_DELAY_MS = 5 * 60 * 1000;

/** Max blob URLs kept when over capacity (evicts idle entries first). */
export const BLOB_URL_POOL_MAX_ENTRIES = 200;

type PoolEntry = {
  blobUrl: string;
  refCount: number;
  evictTimer?: ReturnType<typeof setTimeout>;
  lastAccess: number;
};

/**
 * Reference-counted blob URL pool with delayed eviction.
 * Keeps decrypted media warm briefly after the last consumer unmounts.
 */
export class BlobUrlPool {
  private readonly entries = new Map<string, PoolEntry>();

  /** Returns a retained blob URL when the key is already cached. */
  tryRetain(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.evictTimer) {
      clearTimeout(entry.evictTimer);
      entry.evictTimer = undefined;
    }
    entry.refCount++;
    entry.lastAccess = Date.now();
    return entry.blobUrl;
  }

  /** Registers a new blob URL or increments the ref count for an existing one. */
  retain(key: string, blobUrl: string): string {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.evictTimer) {
        clearTimeout(existing.evictTimer);
        existing.evictTimer = undefined;
      }
      existing.refCount++;
      existing.lastAccess = Date.now();
      return existing.blobUrl;
    }
    this.entries.set(key, { blobUrl, refCount: 1, lastAccess: Date.now() });
    this.enforceMaxSize();
    return blobUrl;
  }

  /** Decrements the ref count; schedules eviction when it reaches zero. */
  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount > 0) return;
    entry.evictTimer = setTimeout(() => {
      const current = this.entries.get(key);
      if (!current || current.refCount > 0) return;
      URL.revokeObjectURL(current.blobUrl);
      this.entries.delete(key);
    }, BLOB_URL_EVICT_DELAY_MS);
  }

  private enforceMaxSize(): void {
    if (this.entries.size <= BLOB_URL_POOL_MAX_ENTRIES) return;
    const idle = [...this.entries.entries()]
      .filter(([, entry]) => entry.refCount <= 0)
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    for (const [key, entry] of idle) {
      if (this.entries.size <= BLOB_URL_POOL_MAX_ENTRIES) break;
      if (entry.evictTimer) clearTimeout(entry.evictTimer);
      URL.revokeObjectURL(entry.blobUrl);
      this.entries.delete(key);
    }
  }
}
