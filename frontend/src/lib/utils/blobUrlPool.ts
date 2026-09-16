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

/** How a pool behaves when the last consumer leaves, and how many blobs it will hold. */
export interface BlobUrlPoolOptions {
  /**
   * Milliseconds to keep a blob after its last release, so an SPA navigation does not re-decode.
   *
   * ZERO REVOKES SYNCHRONOUSLY rather than on a 0 ms timer: a caller that releases and immediately
   * re-renders must not observe a URL that is about to die, and "revoked on the next tick" is a
   * timing-dependent answer to a question that has a definite one.
   */
  evictDelayMs?: number;
  /** Cap on held blobs; the idlest go first when it is exceeded. `Infinity` never evicts by size. */
  maxEntries?: number;
}

/**
 * REFERENCE-COUNTED BLOB URLS, AND THE ONLY IMPLEMENTATION OF THAT IN THIS APP.
 *
 * `URL.createObjectURL` hands out a URL that keeps its bytes alive until something revokes it, and
 * a list drawing the same face twenty times wants ONE blob with twenty holders. Counting them was
 * written THREE times before 2026-09-16 - here, in `userAvatarCache.ts` and in
 * `associationLogoCache.ts` - and the three did not agree on what happens when a key is retained
 * with a DIFFERENT blob: two revoked the one still being displayed, this one leaked the new one.
 *
 * The two policies that genuinely differ are now arguments, not implementations: decrypted media
 * stays warm for five minutes under a 200-entry cap, while avatars and logos revoke at once and are
 * bounded by how many faces are on screen.
 */
export class BlobUrlPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly evictDelayMs: number;
  private readonly maxEntries: number;

  constructor(options: BlobUrlPoolOptions = {}) {
    this.evictDelayMs = options.evictDelayMs ?? BLOB_URL_EVICT_DELAY_MS;
    this.maxEntries = options.maxEntries ?? BLOB_URL_POOL_MAX_ENTRIES;
  }

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

  /**
   * Registers a new blob URL or increments the ref count for an existing one.
   *
   * WHEN THE KEY IS ALREADY HELD, THE BLOB ALREADY BEING DISPLAYED WINS and the one passed in is
   * revoked. Two races reach here - two loads of the same URL completing, or a re-render beating a
   * release - and the alternative, revoking the held URL, breaks every `<img>` currently pointing
   * at it. Returning the held one while silently dropping the new one on the floor was the leak.
   */
  retain(key: string, blobUrl: string): string {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.evictTimer) {
        clearTimeout(existing.evictTimer);
        existing.evictTimer = undefined;
      }
      existing.refCount++;
      existing.lastAccess = Date.now();
      if (blobUrl !== existing.blobUrl && blobUrl.startsWith('blob:')) {
        URL.revokeObjectURL(blobUrl);
      }
      return existing.blobUrl;
    }
    this.entries.set(key, { blobUrl, refCount: 1, lastAccess: Date.now() });
    this.enforceMaxSize();
    return blobUrl;
  }

  /** Decrements the ref count; revokes at once, or schedules eviction, when it reaches zero. */
  release(key: string | null): void {
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount > 0) return;
    if (this.evictDelayMs === 0) {
      URL.revokeObjectURL(entry.blobUrl);
      this.entries.delete(key);
      return;
    }
    entry.evictTimer = setTimeout(() => {
      const current = this.entries.get(key);
      if (!current || current.refCount > 0) return;
      URL.revokeObjectURL(current.blobUrl);
      this.entries.delete(key);
    }, this.evictDelayMs);
  }

  private enforceMaxSize(): void {
    if (this.entries.size <= this.maxEntries) return;
    const idle = [...this.entries.entries()]
      .filter(([, entry]) => entry.refCount <= 0)
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    for (const [key, entry] of idle) {
      if (this.entries.size <= this.maxEntries) break;
      if (entry.evictTimer) clearTimeout(entry.evictTimer);
      URL.revokeObjectURL(entry.blobUrl);
      this.entries.delete(key);
    }
  }
}
