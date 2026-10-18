import { Logger } from '@nestjs/common';

/**
 * A SMALL, BOUNDED MEMORY OF RENDERED CARDS, WITH ONE RENDER PER KEY IN FLIGHT.
 *
 * Nothing sits in front of `/preview-image`: canari.emse.fr is not behind a CDN, so every crawler hit
 * would otherwise fetch the ciphertext, decrypt it and re-encode a JPEG, and a shared link produces a
 * burst of exactly those hits (several unfurlers, each retrying). The key is the post id, its
 * `updatedAt` and its association's stored logo URL (which carries its own `?v=` cache-buster), so an
 * edit or a new logo is a different key and a stale card is never served; nothing is ever evicted by
 * a clock.
 *
 * - LRU by a BYTE budget, not an entry count: a card is ~50-150 kB and the point is a bound on memory;
 * - SINGLE FLIGHT: a burst of N requests for the same key shares one render, and a failed render is
 *   shared by that burst but not remembered - the next request tries again.
 */
export class PostCardCache {
  private readonly logger = new Logger(PostCardCache.name);
  private readonly entries = new Map<string, Buffer>();
  private readonly inflight = new Map<string, Promise<Buffer | null>>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  /** Bytes currently held, for tests and logs. */
  get size(): number {
    return this.bytes;
  }

  async getOrRender(key: string, render: () => Promise<Buffer | null>): Promise<Buffer | null> {
    const hit = this.entries.get(key);
    if (hit) {
      // Re-insert to mark it most recently used (a Map iterates in insertion order).
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const running = this.inflight.get(key);
    if (running) {
      this.logger.debug(`post card ${key}: joined a render in flight`);
      return running;
    }
    const started = render()
      .then((data) => {
        if (data) this.put(key, data);
        return data;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, started);
    return started;
  }

  private put(key: string, data: Buffer): void {
    // A card larger than the whole budget is served but not kept, rather than emptying the cache.
    if (data.length > this.maxBytes) return;
    this.entries.set(key, data);
    this.bytes += data.length;
    for (const [oldest, buf] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.bytes -= buf.length;
    }
  }
}
