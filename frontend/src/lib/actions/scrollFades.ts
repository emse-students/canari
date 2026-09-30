import { Log } from '$lib/utils/Log';

/** How close to an edge, in px, counts as AT it - a sub-pixel scroll position is not "more content". */
const EDGE_SLACK = 2;

/**
 * Says which edges of a horizontal scroller still have content beyond them, so `.scroll-fades` in
 * `app.css` can fade exactly those edges.
 *
 * A row that scrolls sideways with a hidden scrollbar gives no sign that it scrolls at all: the post
 * composer's attachment row cut "Sondage" in half at the right edge, with the rest out of reach for
 * anyone who did not try to swipe it (measured on both phones, 2026-09-30). A fade on the side that
 * has more says "there is more" without taking any room.
 *
 * It writes `data-fade-start` / `data-fade-end` on the node, and nothing when the row fits - a row
 * with nothing hidden must not look cut. Re-read on scroll and on any size change of the row or of
 * its content, since chips appear and disappear (the camera ones are touch-only).
 */
export function scrollFades(node: HTMLElement) {
  const read = (): void => {
    const max = node.scrollWidth - node.clientWidth;
    const start = max > EDGE_SLACK && node.scrollLeft > EDGE_SLACK;
    const end = max > EDGE_SLACK && node.scrollLeft < max - EDGE_SLACK;
    node.toggleAttribute('data-fade-start', start);
    node.toggleAttribute('data-fade-end', end);
  };

  node.classList.add('scroll-fades');
  node.addEventListener('scroll', read, { passive: true });
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
  if (!observer) Log.d('scrollFades', 'no ResizeObserver - fades follow scrolling only');
  observer?.observe(node);
  for (const child of Array.from(node.children)) observer?.observe(child);
  read();

  return {
    destroy() {
      node.removeEventListener('scroll', read);
      observer?.disconnect();
    },
  };
}
