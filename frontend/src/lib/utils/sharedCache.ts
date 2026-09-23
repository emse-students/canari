/**
 * ONE ANSWER, HELD FOR A WHILE, SHARED BY EVERY CALLER THAT ASKS FOR IT.
 *
 * WHAT IT IS FOR. Several screens read the same slowly-changing list - the association directory,
 * the reader's saved payment methods, their own profile - and each one asked for it again on every
 * mount. Switching tab therefore cost a round trip to redraw a list the device had just drawn, and
 * a page rendering N tiles that each ask for the same thing cost N identical requests in the same
 * frame. On a narrow link that IS the tab switch.
 *
 * TWO MECHANISMS, AND THEY ARE NOT THE SAME ONE:
 *
 * - **the TTL** answers "I was told this recently, I am not asking again", which is what makes a
 *   tab switch cost nothing;
 * - **the in-flight join** answers "somebody is already asking", which is what collapses N tiles
 *   mounting together into one request. A TTL alone never covers that: the first tap of every
 *   window races itself.
 *
 * A REJECTION IS NOT AN ANSWER AND IS NEVER HELD. The entry is dropped and the next caller asks
 * again - a cached failure would turn one dropped frame into minutes of a screen that refuses to
 * load, and a transport failure is not a statement about the data.
 *
 * NOT A STORE, AND DELIBERATELY NOT REACTIVE. It holds what the server last said; a screen that
 * changes the data calls {@link SharedCache.invalidate} at the write, which is the only moment
 * anything here can know the held answer is wrong.
 *
 * THE TTL IS THE FLOOR, NOT THE MECHANISM. What keeps an answer right is the invalidation at the
 * write; the window only bounds how long a change made somewhere this client cannot see - another
 * member's browser, a moderator - stays invisible. If a caller ever finds itself choosing a window
 * to make correctness work, the write it forgot to invalidate is the defect.
 */
/**
 * Everything held ABOUT THE SIGNED-IN READER, so that one call can forget all of it.
 *
 * A REGISTRY RATHER THAN A CHECKLIST, and that is the whole point. Several of these caches hold an
 * answer that belongs to one account - the reader's own profile, their memberships, their saved
 * cards - and a list of them written out at the logout site is a list that goes stale the first
 * time somebody adds a cache and does not think about logging out. Here a cache declares itself,
 * once, where it is built.
 */
const perReaderCaches = new Set<() => void>();

/**
 * Registers something to be forgotten when the reader changes, for state that is not a
 * {@link SharedCache} - a bare promise, a derived flag.
 */
export function registerPerReaderCache(forget: () => void): void {
  perReaderCaches.add(forget);
}

/**
 * Forgets everything held about the reader who was signed in.
 *
 * Called from the two places that know the reader changed: signing out, and signing in as somebody
 * else. Nothing here is a security boundary - a token is what authorises a request - but showing
 * one account the previous account's memberships is a defect on its own terms.
 */
export function forgetReaderCaches(): void {
  for (const forget of perReaderCaches) forget();
}

export class SharedCache<T> {
  private readonly held = new Map<string, { value: T; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<T>>();

  /**
   * @param ttlMs how long an answer stays usable without asking again.
   * @param options `perReader` when the answer belongs to the signed-in account, which enrols it in
   * {@link forgetReaderCaches}. Anything keyed to `me`, or read from a `/me/` endpoint, is one.
   */
  constructor(
    private readonly ttlMs: number,
    options?: { perReader?: boolean }
  ) {
    if (options?.perReader) registerPerReaderCache(() => this.invalidate());
  }

  /** The answer held for this key, or `null` when there is none or it has expired. */
  private peek(key: string): T | null {
    const entry = this.held.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    return null;
  }

  /**
   * The answer for this key: held if fresh, joined if somebody is already asking, fetched
   * otherwise.
   *
   * `fetcher` is only called when neither of the first two applies, so a caller may build it
   * unconditionally.
   */
  load(key: string, fetcher: () => Promise<T>): Promise<T> {
    const fresh = this.peek(key);
    if (fresh !== null) return Promise.resolve(fresh);

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = fetcher()
      .then((value) => {
        this.held.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * Replaces the held answer with one the caller already has - the row a write just returned.
   *
   * WHY THIS EXISTS ALONGSIDE {@link invalidate}: a screen that just updated something knows the
   * new value, and dropping the entry would make the next reader fetch what this one is holding.
   */
  put(key: string, value: T): void {
    this.held.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Drops one key, or everything when no key is given. Call it at a write, never on a timer. */
  invalidate(key?: string): void {
    if (key === undefined) {
      this.held.clear();
      this.inFlight.clear();
      return;
    }
    this.held.delete(key);
    this.inFlight.delete(key);
  }
}
