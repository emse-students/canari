/**
 * A registry of callbacks keyed by post id, shared by the two channels that tell every surface
 * showing a post about a write made on ANOTHER one: the reactions (`postReaction.ts`) and the
 * comments (`postCommentThread.svelte.ts`). One implementation so the subscribe, unsubscribe and
 * isolation rules cannot drift between them.
 */

/**
 * Listeners of one kind, by post id. A post's set is dropped with its last listener, so a feed
 * scrolled past leaves nothing behind.
 */
export class PostListeners<Args extends unknown[]> {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a registry of callbacks, never rendered
  private readonly byPost = new Map<string, Set<(...args: Args) => void>>();

  /**
   * @param tag the log prefix naming the channel, so a failing listener says which one it was.
   * @param what what the channel carries, as the failure line names it ("reactions", "comments").
   */
  constructor(
    private readonly tag: string,
    private readonly what: string
  ) {}

  /**
   * Calls every listener of `postId` with `args`. A listener that throws is logged and does not
   * stop the others - isolation is a `try` per subscriber.
   */
  publish(postId: string, ...args: Args): void {
    for (const listener of this.byPost.get(postId) ?? []) {
      try {
        listener(...args);
      } catch (err) {
        console.error(`[${this.tag}] a listener failed to take the ${this.what} of ${postId}`, err);
      }
    }
  }

  /** Adds `listener` for `postId`. Returns the unsubscribe. */
  on(postId: string, listener: (...args: Args) => void): () => void {
    let set = this.byPost.get(postId);
    if (!set) {
      set = new Set();
      this.byPost.set(postId, set);
    }
    set.add(listener);
    return () => {
      const current = this.byPost.get(postId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.byPost.delete(postId);
    };
  }
}
