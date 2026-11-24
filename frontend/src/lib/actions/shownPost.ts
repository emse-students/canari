import { scrollRoot } from '$lib/actions/nearViewport';

/**
 * Calls back ONCE, the first time MOST of a post card is on screen - what "this device displayed the
 * post" means (owner, 2026-11-24: a campus trend for a post already seen shows nothing on this
 * device, `seenPosts.ts`).
 *
 * `threshold` is the share of the card that must be visible (0.5): enough that a card the reader
 * flicked past at the edge of the screen is not counted, and the same "looked at" bar the feed's
 * videos use (`playWhileVisible`). A card TALLER than the scrolling box can never show half of itself,
 * so it also counts once it fills at least half of that box. No dwell time: a clock would be a guess,
 * and the card was drawn.
 *
 * ONE-SHOT: a post displayed once stays displayed, so the observer disconnects when it fires. The
 * root is the nearest scrolling ancestor (`scrollRoot`), as `nearViewport` does, because the feed
 * scrolls inside its own box rather than the page.
 *
 * WITHOUT `IntersectionObserver` it fires at once - a capability check, not a fallback: the card
 * exists on screen, which is what the observer would have said. A post opened on its own page is
 * displayed from the first frame, and the same call covers it.
 */
export interface ShownPostOptions {
  /** Called once, when the card is shown. */
  onshown: () => void;
  /** Share of the card that must be visible. Defaults to 0.5. */
  threshold?: number;
}

export function shownPost(node: HTMLElement, options: ShownPostOptions) {
  let opts = options;
  let observer: IntersectionObserver | null = null;
  let fired = false;

  function fire() {
    if (fired) return;
    fired = true;
    observer?.disconnect();
    observer = null;
    opts.onshown();
  }

  if (typeof IntersectionObserver === 'undefined') {
    fire();
    return {
      update(next: ShownPostOptions) {
        opts = next;
      },
      destroy() {},
    };
  }

  const need = opts.threshold ?? 0.5;
  observer = new IntersectionObserver(
    (entries) => {
      const last = entries[entries.length - 1];
      if (!last?.isIntersecting) return;
      const box = last.rootBounds?.height ?? window.innerHeight;
      if (
        last.intersectionRatio >= need ||
        (box > 0 && last.intersectionRect.height >= box * need)
      ) {
        fire();
      }
    },
    { root: scrollRoot(node), threshold: [need, 0.99] }
  );
  observer.observe(node);

  return {
    update(next: ShownPostOptions) {
      opts = next;
    },
    destroy() {
      observer?.disconnect();
      observer = null;
    },
  };
}
