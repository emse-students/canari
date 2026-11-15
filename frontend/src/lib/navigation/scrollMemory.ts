import { Log } from '$lib/utils/Log';
import { PAGE_SCROLLER_SELECTOR } from './scrollToTop';

/**
 * A PAGE IS REOPENED WHERE IT WAS LEFT, WHEN THE READER GOES BACK TO IT (owner report, 2026-11-15:
 * Back from an association must land on the feed, and at the same post).
 *
 * SvelteKit restores the scroll of the WINDOW; this app's pages scroll inside ONE box
 * (`.page-scroll-wrap`, see `scrollToTop.ts`), so a Back landed on the top of the feed and the
 * reader lost their place in it. The layout records the box's offset as a navigation LEAVES a page
 * ({@link rememberLeaving}, keyed by the page's address) and puts it back on a history Back or
 * Forward ({@link restoreOnReturn}) - never on a link, which opens a page at its top.
 *
 * A feed draws its cards after the page is on screen, so the offset may not exist yet. The restore
 * therefore WAITS FOR THE CONTENT, by a ResizeObserver and not a timer: it applies the offset the
 * moment the box is tall enough, and it ENDS on the first of: the offset applied, a touch / wheel /
 * key from the reader (they are scrolling by themselves now), or the next navigation
 * ({@link cancelRestore}). Each of the three is an event, so the wait cannot outlive the page.
 */

const MAX_REMEMBERED = 40;
const remembered = new Map<string, number>();
let stopRestore: (() => void) | null = null;

/** The address a page is remembered under: path and query, never the fragment. */
export function scrollKey(url: URL): string {
  return url.pathname + url.search;
}

/** Records where the page box was when `url` was left. Zero is forgotten rather than stored. */
export function rememberLeaving(url: URL, top: number): void {
  const key = scrollKey(url);
  remembered.delete(key);
  if (top > 0) remembered.set(key, Math.round(top));
  if (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value as string);
}

/** The offset a page was left at, if any. */
export function recallScroll(url: URL): number | undefined {
  return remembered.get(scrollKey(url));
}

/** Ends a restore still waiting for its content: a navigation has begun. */
export function cancelRestore(): void {
  stopRestore?.();
  stopRestore = null;
}

/**
 * Puts the box of `url` back where it was left, as soon as its content is tall enough. Returns
 * whether there was anything to restore (a first visit, or one left at the top, has not).
 */
export function restoreOnReturn(
  url: URL,
  page: HTMLElement | null = document.querySelector<HTMLElement>(PAGE_SCROLLER_SELECTOR)
): boolean {
  cancelRestore();
  const target = recallScroll(url);
  if (!page || !target) return false;
  const scroller: HTMLElement = page;
  const reached = () => scroller.scrollHeight - scroller.clientHeight >= target;
  const apply = () => {
    scroller.scrollTop = target;
    Log.d('scrollMemory', `restored ${scrollKey(url)} to ${target}px`);
  };
  if (reached()) {
    apply();
    return true;
  }
  const observer = new ResizeObserver(() => {
    if (!reached()) return;
    stop();
    apply();
  });
  const userScrolled = () => stop();
  const events = ['wheel', 'touchstart', 'keydown'] as const;
  function stop() {
    observer.disconnect();
    for (const e of events) scroller.removeEventListener(e, userScrolled);
    if (stopRestore === stop) stopRestore = null;
  }
  for (const e of events) scroller.addEventListener(e, userScrolled, { passive: true });
  // The box itself does not change size while its children grow: watch what it holds.
  observer.observe(scroller);
  for (const child of Array.from(scroller.children)) observer.observe(child);
  stopRestore = stop;
  Log.d('scrollMemory', `waiting for ${scrollKey(url)} to reach ${target}px`);
  return true;
}
