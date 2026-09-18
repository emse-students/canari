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
  /** Called once, the first time the node is within `rootMargin` of the viewport. */
  onnear: () => void;
  /** How far ahead of the viewport counts as near. CSS margin syntax; defaults to `400px`. */
  rootMargin?: string;
}

export function nearViewport(node: HTMLElement, options: NearViewportOptions) {
  let opts = options;
  let observer: IntersectionObserver | null = null;
  let fired = false;

  function fire() {
    if (fired) return;
    fired = true;
    observer?.disconnect();
    observer = null;
    opts.onnear();
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

  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) fire();
    },
    { rootMargin: opts.rootMargin ?? '400px' }
  );
  observer.observe(node);

  return {
    /**
     * The margin is READ ONCE, when the observer is built, and a changed one is not honoured: an
     * `IntersectionObserver` cannot be re-margined, and silently building a second one would double
     * the callbacks for a value no caller here varies. `onnear` is updated, because a component may
     * legitimately re-create its closure on any re-render.
     */
    update(next: NearViewportOptions) {
      opts = next;
    },
    destroy() {
      observer?.disconnect();
      observer = null;
    },
  };
}
