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
  private readonly entries = new Map<string, { value: V; expiresAt: number; weight: number }>();

  /** The summed weight of the retained entries, expired ones included until they are dropped. */
  private totalWeight = 0;

  /**
   * @param maxEntries - hard ceiling on retained entries; the least recently
   *   used one is dropped when a write would exceed it.
   * @param budget - an optional second ceiling, on the summed WEIGHT of the entries (the GIF
   *   relay's bytes: 500 entries of a 12 MiB GIF is not a bound on memory). `weigh` says what one
   *   value costs; least recently used entries go until the sum fits, and a value heavier than the
   *   whole budget is not stored at all.
   */
  constructor(
    private readonly maxEntries: number,
    private readonly budget?: { maxWeight: number; weigh: (value: V) => number }
  ) {}

  /** The cached value, or undefined when absent or expired (an expired entry is dropped). */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt <= Date.now()) {
      this.remove(key);
      return undefined;
    }

    // Re-insert to move the key to the recent end of the iteration order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /**
   * Stores `value` for `ttlMs`, evicting the least recently used entries until both ceilings hold.
   * Returns whether it was stored: only a value heavier than the whole weight budget is not.
   */
  set(key: string, value: V, ttlMs: number): boolean {
    const weight = this.budget ? this.budget.weigh(value) : 0;
    // Delete first so an overwrite counts as a fresh insertion rather than
    // keeping the key at its old, possibly oldest, position.
    this.remove(key);
    if (this.budget && weight > this.budget.maxWeight) return false;
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs, weight });
    this.totalWeight += weight;

    while (
      this.entries.size > this.maxEntries ||
      (this.budget !== undefined && this.totalWeight > this.budget.maxWeight)
    ) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.remove(oldest.value);
    }
    return true;
  }

  /** Number of retained entries, expired ones included. Exposed for tests and logs. */
  get size(): number {
    return this.entries.size;
  }

  /** Summed weight of the retained entries (0 without a budget). Exposed for tests and logs. */
  get weight(): number {
    return this.totalWeight;
  }

  /** Drops everything. Only used by tests - nothing in the service invalidates by hand. */
  clear(): void {
    this.entries.clear();
    this.totalWeight = 0;
  }

  /** Drops one entry and its weight - the one place the two are kept in step. */
  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalWeight -= entry.weight;
  }
}
