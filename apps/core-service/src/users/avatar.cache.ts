/**
 * In-process cache for the avatars proxied from MiGallery.
 *
 * WHY IT EXISTS: this proxy cached nothing, so the gallery was asked again on every render of every
 * face. A success is spared by the browser (`Cache-Control: max-age`), but an ABSENCE was not - and
 * an account with no photo is the common case, not the edge one: the campaign's own two accounts
 * measured 40/40 upstream 404s on 2026-08-15. So one conversation list re-opened the same outbound
 * connections indefinitely, which is the amplification that turns ONE transient network fault into a
 * burst of 502s rather than a single line. The same shape, measured on the portal, turned one
 * outbound failure into 479 recorded 502s.
 *
 * WHAT IT DELIBERATELY DOES NOT STORE: failures. "I could not reach MiGallery" is not an answer
 * about the avatar, so it is re-attempted on the next request; caching it would make a passing
 * outage stick for a whole TTL, which is the link-preview defect in another service. Only the two
 * real ANSWERS are stored - the image, and the upstream's "this user has none".
 *
 * The clock is injected because a test must never assert a wall clock, and the entry count is capped
 * because this process is long-lived and the number of distinct users is not ours to bound.
 */

/** The two answers the upstream can actually give about an avatar. */
export type AvatarAnswer =
  | { readonly kind: 'image'; readonly body: Buffer; readonly contentType: string }
  | { readonly kind: 'absent' };

/**
 * Whether a non-ok upstream status means "this user has no avatar" - the only negative that may be
 * cached.
 *
 * A 404 is an answer about the avatar. A 401 on a rotated key, a 429, or a 5xx from MiGallery are
 * answers about MIGALLERY, and storing one as an absence would turn one upstream fault into ten
 * minutes of missing faces across the whole site.
 */
export const isCacheableAbsence = (status: number): boolean => status === 404;

export interface AvatarCacheOptions {
  /** How long a fetched image stays fresh. */
  readonly imageTtlMs: number;
  /** How long an "upstream has none" stays fresh. Shorter: a user may add one. */
  readonly absentTtlMs: number;
  /** Hard ceiling on stored entries; past it the oldest insertion is evicted. */
  readonly maxEntries: number;
  /** Injectable clock, so tests advance time instead of waiting for it. */
  readonly now?: () => number;
}

interface Slot {
  readonly answer: AvatarAnswer;
  readonly expiresAt: number;
}

export class AvatarCache {
  private readonly slots = new Map<string, Slot>();
  private readonly imageTtlMs: number;
  private readonly absentTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: AvatarCacheOptions) {
    this.imageTtlMs = options.imageTtlMs;
    this.absentTtlMs = options.absentTtlMs;
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? (() => Date.now());
  }

  /** Number of stored entries, expired ones included until they are read. */
  get size(): number {
    return this.slots.size;
  }

  /**
   * The cached answer for `userId`, or null when absent or stale. An expired slot is dropped on
   * read, so a key that stops being requested cannot pin its payload in memory for ever.
   */
  get(userId: string): AvatarAnswer | null {
    const slot = this.slots.get(userId);
    if (!slot) return null;
    if (slot.expiresAt <= this.now()) {
      this.slots.delete(userId);
      return null;
    }
    return slot.answer;
  }

  /**
   * Store an answer, refreshing its position so eviction removes the least-recently-WRITTEN key
   * rather than the least-recently-read one.
   */
  set(userId: string, answer: AvatarAnswer): void {
    const ttl = answer.kind === 'image' ? this.imageTtlMs : this.absentTtlMs;
    this.slots.delete(userId);
    this.slots.set(userId, { answer, expiresAt: this.now() + ttl });
    while (this.slots.size > this.maxEntries) {
      // Map iterates in insertion order, so the first key is the oldest write.
      const oldest = this.slots.keys().next();
      if (oldest.done) break;
      this.slots.delete(oldest.value);
    }
  }

  /** Drop everything. Exists for tests; nothing in the application calls it. */
  clear(): void {
    this.slots.clear();
  }
}
