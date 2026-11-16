import { Log } from '$lib/utils/Log';
import { memoryFor, memoryOf } from './historyEntry';
import { cancelRestore, isActiveRestore, setActiveRestore } from './restoreControl';
import { PAGE_SCROLLER_SELECTOR } from './scrollToTop';

export { cancelRestore };

/**
 * A PAGE IS REOPENED WHERE IT WAS LEFT, WHEN THE READER GOES BACK TO IT (owner report, 2026-11-15:
 * Back from an association must land on the feed, and at the same post).
 *
 * SvelteKit restores the scroll of the WINDOW; this app's pages scroll inside ONE box
 * (`.page-scroll-wrap`, see `scrollToTop.ts`), so a Back landed on the top of the feed and the
 * reader lost their place in it. The layout records the box's place against the HISTORY ENTRY as a
 * navigation leaves it ({@link rememberLeaving}; two `/posts` entries keep two places) and puts it
 * back on a history Back or Forward ({@link restoreOnReturn}) - never on a link, which opens a page
 * at its top.
 *
 * THE OFFSET IS ONLY HALF OF THE PLACE (`1.7.0-alpha.2`, Mi 9T: left at 1500 px, back at 1726). A
 * `scrollTop` is a distance in the layout it was measured in, and a feed's layout is not the same
 * twice: cards mount a few at a time, a suggestions strip appears, images and posters settle to
 * their height. A distance applied to a layout that is not the one it was measured in shows another
 * post (HYPOTHESIS, not measured: the layout above the post was taller at the restore than when the
 * reader left). So the entry also records an ANCHOR: the first element of the box that is on screen
 * and wears `data-scroll-anchor="<id>"` (a feed card wears its post id), with its distance from the
 * box's top. The restore waits for that element, scrolls so that IT sits at that distance again, and
 * keeps aligning it while the content above changes, until the page is quiet or the reader touches
 * it. The box has a FIXED height and never resizes, so what is observed is its content: a
 * ResizeObserver on the box's first child, on the list holding the anchor and on the anchor itself,
 * a MutationObserver on the subtree, and the `load` events of images and media (a poster settling
 * touches no DOM). Another programmatic scroll (a tap on the tab, a change of feed tab) ends the
 * restore first ({@link cancelRestore}). The raw offset stays the answer for a page with no anchor,
 * and for an anchor that is gone (a post deleted meanwhile, a re-ranked tab, a post beyond the
 * loaded page): that is a fallback, logged as a warning naming the anchor.
 *
 * A feed draws after the page is on screen, so the place may not exist yet, and a skeleton is as tall
 * as the cards it stands for. The restore therefore applies only once the target exists (an offset:
 * the box is tall enough; an anchor: it is drawn) AND no placeholder is shown (a list skeleton
 * declares itself with `data-loading-skeleton`), and it ENDS at the first of, all events and none a
 * clock: an offset applied; an anchor aligned and then two frames with no further change; the first
 * change of the page after which no placeholder is left, the target is missing and two frames pass
 * with no further change (settled: the offset applies, clamped by the browser when the page came
 * back shorter); ANY scroll event while it waits (it never scrolls the box before it applies, so
 * such an event is the reader's); a wheel, touch, pointer or key event at any time (the reader, once
 * the restore itself scrolls the box); or the next navigation or programmatic scroll.
 */

/** The marker of an element a page can be re-aligned on: its value is a stable id of the content. */
export const SCROLL_ANCHOR_ATTRIBUTE = 'data-scroll-anchor';

/**
 * The first anchor still on screen (its bottom is below the box's top), with its distance from the
 * top. Anchors are in document order, so their bottoms only grow: a binary search reads O(log n)
 * rects (each one a layout read) instead of all of them.
 */
function anchorOnScreen(scroller: HTMLElement): { id: string; offset: number } | undefined {
  const top = scroller.getBoundingClientRect().top;
  const anchors = scroller.querySelectorAll<HTMLElement>(`[${SCROLL_ANCHOR_ATTRIBUTE}]`);
  let lo = 0;
  let hi = anchors.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid].getBoundingClientRect().bottom > top) hi = mid;
    else lo = mid + 1;
  }
  const el = anchors[lo];
  if (!el) return undefined;
  return {
    id: el.getAttribute(SCROLL_ANCHOR_ATTRIBUTE) ?? '',
    offset: Math.round(el.getBoundingClientRect().top - top),
  };
}

/** The anchor element of id `id`, by one attribute selector (quotes and backslashes escaped). */
function findAnchor(scroller: HTMLElement, id: string): HTMLElement | undefined {
  const escaped = id.replace(/["\\]/g, '\\$&');
  return (
    scroller.querySelector<HTMLElement>(`[${SCROLL_ANCHOR_ATTRIBUTE}="${escaped}"]`) ?? undefined
  );
}

/**
 * Records where the page box was when the entry `key` was left: its offset and, when `scroller` is
 * given, the anchor on screen. Zero is forgotten.
 */
export function rememberLeaving(
  key: number | undefined,
  top: number,
  scroller?: HTMLElement | null
): void {
  if (key === undefined) return;
  const memory = memoryFor(key);
  if (top > 0) {
    memory.top = Math.round(top);
    const anchor = scroller ? anchorOnScreen(scroller) : undefined;
    if (anchor?.id) memory.anchor = anchor;
    else delete memory.anchor;
  } else {
    delete memory.top;
    delete memory.anchor;
  }
}

/** The offset an entry was left at, if any. */
export function recallScroll(key: number | undefined): number | undefined {
  return memoryOf(key)?.top;
}

/**
 * The marker a LIST skeleton carries (`data-loading-skeleton`): an explicit declaration by the page
 * that draws it, because `animate-pulse` and `aria-busy` are also worn by things that are never gone
 * (a live dot that pulses for ever, a per-image loader stuck on a failed image, a busy button).
 */
export const LOADING_SKELETON_ATTRIBUTE = 'data-loading-skeleton';

/** Whether the box still shows a list skeleton. */
function placeholderShown(scroller: HTMLElement): boolean {
  return scroller.querySelector(`[${LOADING_SKELETON_ATTRIBUTE}]`) !== null;
}

/** What only the reader produces: the restore's own scrolling never fires these. */
const READER_INPUTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/** What changes the height of content without touching the DOM: images and media, in the capture phase. */
const CONTENT_LOADS = ['load', 'loadedmetadata', 'error'] as const;

/**
 * Puts the box of the entry `key` back where it was left. Returns whether there was anything to
 * restore (a first visit, or a page left at the top, has not).
 */
export function restoreOnReturn(
  key: number | undefined,
  page: HTMLElement | null = document.querySelector<HTMLElement>(PAGE_SCROLLER_SELECTOR)
): boolean {
  cancelRestore();
  const target = recallScroll(key);
  const anchor = memoryOf(key)?.anchor;
  if (!page || !target) return false;
  const scroller: HTMLElement = page;
  const tallEnough = () => scroller.scrollHeight - scroller.clientHeight >= target;
  /** Resolved once and reused while it stays in the page: a feed mutates a lot, a lookup is not free. */
  let anchorEl: HTMLElement | undefined;
  const resolveAnchor = () => {
    if (!anchor) return undefined;
    if (!anchorEl?.isConnected) anchorEl = findAnchor(scroller, anchor.id);
    return anchorEl;
  };
  /** With an anchor, reached means THE ANCHOR IS DRAWN: a tall page may still lack its post. */
  const reached = () => (anchor ? resolveAnchor() !== undefined : tallEnough());
  let logged = false;
  const apply = (why: string) => {
    const el = resolveAnchor();
    if (anchor && el) {
      const drift =
        el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
      if (Math.abs(drift) >= 1) scroller.scrollTop += drift;
    } else {
      scroller.scrollTop = target;
    }
    if (!logged) {
      logged = true;
      const where = anchor && el ? `anchor ${anchor.id} at ${anchor.offset}px` : `${target}px`;
      Log.d('scrollMemory', `entry ${key}: ${why}, restored to ${where}`);
    }
  };
  if (!anchor && reached() && !placeholderShown(scroller)) {
    apply('content ready');
    return true;
  }

  const resize = new ResizeObserver(() => settle());
  const mutation = new MutationObserver(() => settle());
  const watched = new Set<Element>();
  /** The box never changes size (fixed height): what grows is its content, so THAT is observed. */
  const watch = (el: Element | null | undefined) => {
    if (!el || watched.has(el)) return;
    watched.add(el);
    resize.observe(el);
  };
  /** Set once the anchor is aligned: the restore then moves the box itself, so only INPUT ends it. */
  let following = false;
  const dropped = (what: string) => {
    Log.d('scrollMemory', `entry ${key}: ${what}, restore dropped`);
    stop();
  };
  const userScrolled = () => {
    if (!following) dropped('the reader scrolled');
  };
  const userInput = () => dropped('the reader touched the page');
  const contentLoaded = () => settle();
  function stop() {
    resize.disconnect();
    mutation.disconnect();
    watched.clear();
    scroller.removeEventListener('scroll', userScrolled);
    for (const e of READER_INPUTS) scroller.removeEventListener(e, userInput);
    for (const e of CONTENT_LOADS) scroller.removeEventListener(e, contentLoaded, true);
    if (isActiveRestore(stop)) setActiveRestore(null);
  }
  let changes = 0;
  /**
   * After a change: still loading, keep waiting; target reached, align it - an offset is then done,
   * an anchor keeps being re-aligned while the content above it changes; otherwise (loaded but
   * shorter, or the anchor never came) finish only after TWO animation frames with no further change
   * - a feed mounts its cards a frame at a time, so a page that is still growing keeps invalidating
   * the check, and a page that has stopped is the settled one. An anchor that never came is a
   * fallback and is logged as one, naming it.
   */
  function settle() {
    changes += 1;
    if (placeholderShown(scroller)) return;
    const reachedNow = reached();
    if (reachedNow) {
      watch(anchorEl);
      watch(anchorEl?.parentElement);
      apply('content ready');
      if (!anchor) {
        stop();
        return;
      }
      following = true;
    }
    const seen = changes;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (seen !== changes || !isActiveRestore(stop)) return;
        stop();
        if (reachedNow) return;
        if (anchor) {
          Log.w(
            'scrollMemory',
            `entry ${key}: anchor ${anchor.id} never appeared (post gone, re-ranked or beyond the loaded page), the raw offset ${target}px is used`
          );
        }
        apply('page settled shorter');
      })
    );
  }
  scroller.addEventListener('scroll', userScrolled, { passive: true });
  for (const e of READER_INPUTS) scroller.addEventListener(e, userInput, { passive: true });
  for (const e of CONTENT_LOADS) scroller.addEventListener(e, contentLoaded, true);
  watch(scroller);
  watch(scroller.firstElementChild);
  mutation.observe(scroller, { childList: true, subtree: true });
  setActiveRestore(stop);
  const goal = anchor ? `anchor ${anchor.id}` : `${target}px`;
  Log.d('scrollMemory', `entry ${key}: waiting to reach ${goal}`);
  // An anchor already drawn is aligned now, and followed until the page is quiet.
  if (anchor && reached() && !placeholderShown(scroller)) settle();
  return true;
}
