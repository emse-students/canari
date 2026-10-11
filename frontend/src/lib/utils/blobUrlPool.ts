/** Delay before revoking an unused blob URL (keeps images warm across SPA navigation). */
export const BLOB_URL_EVICT_DELAY_MS = 5 * 60 * 1000;

/** Max blob URLs kept when over capacity (evicts idle entries first). */
export const BLOB_URL_POOL_MAX_ENTRIES = 200;

/**
 * Max decrypted bytes the pool keeps, held and idle entries counted together.
 *
 * AN ENTRY CAP ALONE BOUNDS NOTHING THAT MATTERS: 200 entries were 200 thumbnails or 200 reels of
 * 30 MB, and a feed scrolled past ten reels kept ~300 MB of plaintext for five minutes (reels
 * audit, 2026-10-11, on a 5.6 GB phone). 64 MiB keeps a feed's pictures and a couple of whole
 * videos warm; when a new blob takes the total past it, the least recently used IDLE entry goes
 * first. A HELD entry - the video on screen, the picture being drawn - is never evicted, whatever
 * the total. The cap is soft: a release alone evicts nothing (see `release`).
 */
export const BLOB_URL_POOL_MAX_BYTES = 64 * 1024 * 1024;

type PoolEntry = {
  blobUrl: string;
  refCount: number;
  /** Size of the blob behind the URL, as the caller declared it (0 when it did not). */
  bytes: number;
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
  /** Cap on held blobs; the idlest go first when it is exceeded. `Infinity` never evicts by count. */
  maxEntries?: number;
  /**
   * Cap on the declared bytes of every entry; idle ones go, least recently used first, when it is
   * exceeded. `Infinity` never evicts by bytes. A held entry is never evicted to honour it.
   */
  maxBytes?: number;
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
 * stays warm for five minutes under a 200-entry and a 64 MiB cap, while avatars and logos revoke at
 * once and are bounded by how many faces are on screen.
 */
export class BlobUrlPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly evictDelayMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  /** Sum of every entry's declared bytes, held or idle. */
  private totalBytes = 0;

  constructor(options: BlobUrlPoolOptions = {}) {
    this.evictDelayMs = options.evictDelayMs ?? BLOB_URL_EVICT_DELAY_MS;
    this.maxEntries = options.maxEntries ?? BLOB_URL_POOL_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? BLOB_URL_POOL_MAX_BYTES;
  }

  /** The declared bytes the pool holds, held and idle entries alike. */
  get bytes(): number {
    return this.totalBytes;
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
   *
   * @param bytes The blob's size, which the byte cap counts. A caller that cannot say passes
   *   nothing and is bounded by the entry cap alone.
   */
  retain(key: string, blobUrl: string, bytes = 0): string {
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
    this.entries.set(key, { blobUrl, refCount: 1, bytes, lastAccess: Date.now() });
    this.totalBytes += bytes;
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
      this.drop(key, entry);
      return;
    }
    entry.evictTimer = setTimeout(() => {
      const current = this.entries.get(key);
      if (!current || current.refCount > 0) return;
      this.drop(key, current);
    }, this.evictDelayMs);
    // NOT evicted here, even over a cap: the cap is SOFT and applies when a NEW blob arrives
    // (`retain`), so an entry released a moment ago - a feed page torn down by a tab swipe - keeps
    // its five minutes of grace until something actually needs the room, and is then the last to go
    // (least recently used first).
  }

  private overBudget(): boolean {
    return this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes;
  }

  private drop(key: string, entry: PoolEntry): void {
    if (entry.evictTimer) clearTimeout(entry.evictTimer);
    URL.revokeObjectURL(entry.blobUrl);
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }

  /** Evicts IDLE entries, least recently used first, until both caps hold or none is left. */
  private enforceMaxSize(): void {
    if (!this.overBudget()) return;
    const idle = [...this.entries.entries()]
      .filter(([, entry]) => entry.refCount <= 0)
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    let evicted = 0;
    for (const [key, entry] of idle) {
      if (!this.overBudget()) break;
      this.drop(key, entry);
      evicted += 1;
    }
    if (evicted > 0) {
      console.debug(
        `[blobUrlPool] evicted ${evicted} idle blob(s); ${this.entries.size} kept, ${this.totalBytes} bytes`
      );
    }
  }
}
