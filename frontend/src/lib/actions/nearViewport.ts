/**
 * Calls back ONCE, the first time a node comes near the viewport.
 *
 * WHAT THIS IS FOR, AND THE ONE THING IT IS NOT. `loading="lazy"` already defers the IMAGE inside a
 * card. It does nothing for the request that decides what the card says - a metadata fetch fired
 * from an effect on render, which runs for every card the page mounts whether or not anyone will
 * ever scroll to it. On a feed that is a dozen requests competing with the boot for the same
 * connection, all of them for content below the fold. This gives that fetch the same rule the
 * browser already applies to the image beside it.
 *
 * ONE-SHOT ON PURPOSE. A preview, once fetched, does not become un-fetched by scrolling away, so
 * there is nothing for a second call to do and an observer left connected is a callback per scroll
 * for the life of the page. It disconnects itself the moment it fires.
 *
 * UNLESS THE CALLER HAS SOMETHING TO GIVE BACK (`onleave`). A feed VIDEO holds a stream, a decoder
 * and its bytes, and keeping them for every card ever scrolled past is what the reels audit found
 * (2026-10-11: ten reels, ~300 MB). With `onleave` the observer stays connected and reports both
 * edges of the same band - `onnear` on entering it, `onleave` on leaving it - so the owner can
 * release what the card holds and take it again on return. The exit edge is FARTHER than the entry
 * edge (`leaveMargin`, 1200px by default, against 400px): with one edge, a card resting on it
 * reopened its stream and refetched its head on every small scroll (review of #1744).
 *
 * THE ROOT IS THE NEAREST SCROLLING ANCESTOR, NOT THE VIEWPORT. The feed scrolls inside
 * `.page-scroll-wrap` (`+layout.svelte`), and an observer rooted at the viewport clips its target
 * by every scrolling ancestor WITHOUT the margin (the IntersectionObserver spec; not measured on a
 * device) - so the "400px ahead" stopped at that box's edge. Rooting
 * the observer at that ancestor is what makes the margin mean what this page says.
 *
 * `rootMargin` defaults to 400px rather than 0: a card that enters the viewport and only THEN
 * starts asking is a card that is blank while the reader is already looking at it. The number is a
 * distance, not a delay - it does not decide WHETHER the work happens, only how far ahead, so
 * getting it wrong costs a little early traffic or a little late paint and never a wrong answer.
 *
 * WITHOUT `IntersectionObserver` IT FIRES AT ONCE, and that is a capability check rather than a
 * fallback path: there is no primary path that failed here, only an environment that cannot answer
 * the question. Answering "yes" preserves exactly the behaviour every caller had before this
 * existed - the alternative, staying silent, would be a preview that never loads at all. It is also
 * what makes this transparent to a test environment that stubs no observer.
 *
 * @example
 * ```svelte
 * <a use:nearViewport={{ onnear: () => (isNear = true) }}>
 * ```
 */
export interface NearViewportOptions {
  /** Called once, the first time the node is within `rootMargin` - or on every entry when `onleave` is set. */
  onnear: () => void;
  /**
   * Called when the node goes farther than `leaveMargin` after `onnear`. Setting it keeps the
   * observers connected (two-way mode).
   */
  onleave?: () => void;
  /** How far ahead of the visible area counts as near. CSS margin syntax; defaults to `400px`. */
  rootMargin?: string;
  /** Two-way only: how far the node must go before it has left. Defaults to `1200px`. */
  leaveMargin?: string;
}

/** The nearest ancestor that scrolls vertically - the box the node actually moves in - or `null`. */
export function scrollRoot(node: HTMLElement): HTMLElement | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return el;
  }
  return null;
}

export function nearViewport(node: HTMLElement, options: NearViewportOptions) {
  let opts = options;
  let observer: IntersectionObserver | null = null;
  let leaveObserver: IntersectionObserver | null = null;
  let fired = false;
  /** Two-way, read once like the margins: an observer is not rebuilt for a changed mode. */
  const twoWay = !!options.onleave;

  function fire() {
    if (fired) return;
    fired = true;
    if (!twoWay) {
      observer?.disconnect();
      observer = null;
    }
    opts.onnear();
  }

  function leave() {
    if (!fired) return;
    fired = false;
    opts.onleave?.();
  }

  if (typeof IntersectionObserver === 'undefined') {
    fire();
    return {
      update(next: NearViewportOptions) {
        opts = next;
      },
      destroy() {},
    };
  }

  const root = scrollRoot(node);
  // The LAST entry is the node's current state; several arrive when it crosses back and forth.
  observer = new IntersectionObserver(
    (entries) => {
      if (entries[entries.length - 1]?.isIntersecting) fire();
    },
    { root, rootMargin: opts.rootMargin ?? '400px' }
  );
  observer.observe(node);
  if (twoWay) {
    leaveObserver = new IntersectionObserver(
      (entries) => {
        if (!entries[entries.length - 1]?.isIntersecting) leave();
      },
      { root, rootMargin: opts.leaveMargin ?? '1200px' }
    );
    leaveObserver.observe(node);
  }

  return {
    /**
     * The margins are READ ONCE, when the observers are built, and a changed one is not honoured:
     * an `IntersectionObserver` cannot be re-margined, and silently building another would double
     * the callbacks for a value no caller here varies. `onnear` and `onleave` are updated, because a
     * component may legitimately re-create its closures on any re-render.
     */
    update(next: NearViewportOptions) {
      opts = next;
    },
    destroy() {
      observer?.disconnect();
      observer = null;
      leaveObserver?.disconnect();
      leaveObserver = null;
    },
  };
}
