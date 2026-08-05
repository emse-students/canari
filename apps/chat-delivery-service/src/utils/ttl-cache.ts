/**
 * A bounded in-memory cache with a per-entry TTL and least-recently-used
 * eviction.
 *
 * It exists because link previews are re-fetched far more often than they
 * change: a conversation re-renders on every reconnect, on every scroll back
 * into view, and on every device the message reaches, and each render asked the
 * remote site again. That is latency for the reader, load for a site that never
 * agreed to it, and - inside an end-to-end encrypted conversation - one more
 * request telling that site somebody is reading.
 *
 * Deliberately per-process rather than Redis: chat-delivery runs as a single
 * instance, so a shared store would be infrastructure bought for nothing. If it
 * is ever replicated, the only consequence is a lower hit rate, never a wrong
 * answer - which is the property that makes the choice reversible.
 */
export class TtlCache<V> {
  /**
   * Insertion-ordered, and re-inserted on every hit, so the first key is always
   * the least recently used one. A Map is the whole LRU: no second structure to
   * keep consistent with it.
   */
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  /**
   * @param maxEntries - hard ceiling on retained entries; the least recently
   *   used one is dropped when a write would exceed it.
   */
  constructor(private readonly maxEntries: number) {}

  /** The cached value, or undefined when absent or expired (an expired entry is dropped). */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    // Re-insert to move the key to the recent end of the iteration order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Stores `value` for `ttlMs`, evicting the least recently used entry if full. */
  set(key: string, value: V, ttlMs: number): void {
    // Delete first so an overwrite counts as a fresh insertion rather than
    // keeping the key at its old, possibly oldest, position.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Number of retained entries, expired ones included. Exposed for tests and logs. */
  get size(): number {
    return this.entries.size;
  }

  /** Drops everything. Only used by tests - nothing in the service invalidates by hand. */
  clear(): void {
    this.entries.clear();
  }
}
