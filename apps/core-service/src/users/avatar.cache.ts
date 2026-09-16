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
  | {
      readonly kind: 'image';
      readonly body: Buffer;
      readonly contentType: string;
      /**
       * MiGallery's own version of the photo, when it sent one.
       *
       * IT IS KEYED ON THE ASSET ID UPSTREAM, so it changes exactly when the user changes their
       * photo and at no other time - which is the one thing a TTL can never know. Optional because
       * an upstream that sends no ETag is still a perfectly good answer; it simply cannot be
       * revalidated, and falls back to being re-downloaded when its TTL lapses, as before.
       */
      readonly etag?: string;
    }
  | { readonly kind: 'absent' };

/** A lapsed image that carries a version the upstream can confirm or replace in one round trip. */
export interface RevalidatableAvatar {
  readonly body: Buffer;
  readonly contentType: string;
  readonly etag: string;
}

/**
 * What the cache holds for one user, and the THIRD state is the point.
 *
 * `fresh` and `miss` were the whole vocabulary, so every lapse of the TTL was a full re-download of
 * a photo that had almost certainly not changed - hourly, per replica, per face. `stale` is the
 * state where we still hold the bytes AND a version the upstream can check, which turns that
 * re-download into a 304 with an empty body.
 */
export type AvatarLookup =
  | { readonly state: 'fresh'; readonly answer: AvatarAnswer }
  | { readonly state: 'stale'; readonly answer: RevalidatableAvatar }
  | { readonly state: 'miss' };

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
   * Classifies what is held for `userId`: usable as is, revalidatable, or nothing.
   *
   * AN EXPIRED SLOT IS KEPT ONLY WHEN IT CAN BE REVALIDATED, and dropped otherwise. That is the
   * whole of the memory argument: an entry with no ETag can do nothing but be re-downloaded, so
   * holding it would pin a payload for a key that may never be asked for again. An entry WITH one
   * is about to be handed to a conditional request whose answer rewrites or replaces it, and the
   * `maxEntries` ceiling bounds it either way.
   *
   * An absence is never stale: there is no version to confirm, and "this user has none" is cheap to
   * ask again.
   */
  lookup(userId: string): AvatarLookup {
    const slot = this.slots.get(userId);
    if (!slot) return { state: 'miss' };
    if (slot.expiresAt > this.now()) return { state: 'fresh', answer: slot.answer };

    const answer = slot.answer;
    if (answer.kind === 'image' && answer.etag) {
      return {
        state: 'stale',
        answer: { body: answer.body, contentType: answer.contentType, etag: answer.etag },
      };
    }
    this.slots.delete(userId);
    return { state: 'miss' };
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
