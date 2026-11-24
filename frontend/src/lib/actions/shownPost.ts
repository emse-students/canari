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

/** One shared observer: every card of one scroll root and one threshold. */
interface Group {
  observer: IntersectionObserver;
  watched: Map<Element, () => void>;
}
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a registry of observers, never read by a screen
const groups = new Map<HTMLElement | null, Map<number, Group>>();

function leave(root: HTMLElement | null, need: number, node: Element): void {
  const group = groups.get(root)?.get(need);
  if (!group) return;
  group.observer.unobserve(node);
  group.watched.delete(node);
  if (group.watched.size > 0) return;
  group.observer.disconnect();
  const byNeed = groups.get(root);
  byNeed?.delete(need);
  if (byNeed?.size === 0) groups.delete(root);
}

/**
 * The group of `root` and `need`, created on first use. ONE observer per scroll root: the cards that
 * cross the threshold in the same frame arrive in ONE callback, so they are noted in one tick and
 * share one write of the record (`seenPosts.svelte.ts`) - a write per card would be one per scroll
 * step. Never a timer.
 */
function groupFor(root: HTMLElement | null, need: number): Group {
  let byNeed = groups.get(root);
  if (!byNeed) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a registry, never read by a screen
    byNeed = new Map();
    groups.set(root, byNeed);
  }
  let group = byNeed.get(need);
  if (group) return group;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a registry, never read by a screen
  const watched = new Map<Element, () => void>();
  const observer = new IntersectionObserver(
    (entries) => {
      // The LAST entry of a card is its current state; several arrive when it crosses back and forth.
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, never read by a screen
      const latest = new Map<Element, IntersectionObserverEntry>();
      for (const entry of entries) latest.set(entry.target, entry);
      for (const [target, entry] of latest) {
        if (!entry.isIntersecting) continue;
        const box = entry.rootBounds?.height ?? window.innerHeight;
        if (
          entry.intersectionRatio >= need ||
          (box > 0 && entry.intersectionRect.height >= box * need)
        ) {
          watched.get(target)?.();
        }
      }
    },
    { root, threshold: [need, 0.99] }
  );
  group = { observer, watched };
  byNeed.set(need, group);
  return group;
}

export function shownPost(node: HTMLElement, options: ShownPostOptions) {
  let opts = options;
  let fired = false;

  if (typeof IntersectionObserver === 'undefined') {
    opts.onshown();
    return {
      update(next: ShownPostOptions) {
        opts = next;
      },
      destroy() {},
    };
  }

  const need = opts.threshold ?? 0.5;
  const root = scrollRoot(node);
  const group = groupFor(root, need);
  group.watched.set(node, () => {
    if (fired) return;
    fired = true;
    leave(root, need, node);
    opts.onshown();
  });
  group.observer.observe(node);

  return {
    update(next: ShownPostOptions) {
      opts = next;
    },
    destroy() {
      leave(root, need, node);
    },
  };
}
