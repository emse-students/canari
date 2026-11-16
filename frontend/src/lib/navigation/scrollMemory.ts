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
 * clock and never by the page going quiet (a live dot mutates for ever): an offset applied; an anchor
 * confirmed in place on two consecutive frames (a drifted frame re-aligns it and restarts the count; an
 * anchor that leaves the page after it was aligned just ends it); a target that is missing while the
 * scrollable height is unchanged on two consecutive frames (settled: the offset applies, clamped by
 * the browser when the page came back shorter, logged as a fallback); ANY scroll event while it waits (it never scrolls the box before it applies, so
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

/** An id that needs no escaping in an attribute selector: what every post and entity id is (uuid, number). */
const PLAIN_ID = /^[\w-]+$/;

/**
 * The anchor element of id `id`. A plain id (every id the app writes) is ONE attribute selector, so
 * nothing is scanned on a mutation. An id with any other character (quotes, brackets, control
 * characters) is compared as a string over the anchors instead of being escaped into a selector:
 * `CSS.escape` is missing from some engines and test DOMs, a hand-made escape is a parser bet, and
 * a selector that throws inside an observer callback would end the page's restore for good.
 */
function findAnchor(scroller: HTMLElement, id: string): HTMLElement | undefined {
  if (PLAIN_ID.test(id)) {
    return scroller.querySelector<HTMLElement>(`[${SCROLL_ANCHOR_ATTRIBUTE}="${id}"]`) ?? undefined;
  }
  for (const el of scroller.querySelectorAll<HTMLElement>(`[${SCROLL_ANCHOR_ATTRIBUTE}]`)) {
    if (el.getAttribute(SCROLL_ANCHOR_ATTRIBUTE) === id) return el;
  }
  return undefined;
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
  const documentKey = () => dropped('the reader pressed a key');
  const contentLoaded = () => settle();
  function stop() {
    resize.disconnect();
    mutation.disconnect();
    watched.clear();
    scroller.removeEventListener('scroll', userScrolled);
    document.removeEventListener('keydown', documentKey);
    for (const e of READER_INPUTS) scroller.removeEventListener(e, userInput);
    for (const e of CONTENT_LOADS) scroller.removeEventListener(e, contentLoaded, true);
    if (isActiveRestore(stop)) setActiveRestore(null);
  }
  /**
   * AFTER A CHANGE the target is aligned (an anchor) or the restore ends (an offset), and ONE frame
   * loop runs, ending by a PROOF and never by a clock or by the page going quiet - a feed with a
   * live dot or a counter mutates for ever:
   * - the anchor is reached: it ends on the second consecutive frame where the anchor sits within a
   *   pixel of its place (confirmed twice); a frame where it had drifted re-aligns it and starts the
   *   count again; an anchor that disappears after it was aligned just ends the restore (no jump:
   *   the page has moved on, and the raw offset would be wrong);
   * - it is not reached: it ends on the second consecutive frame where the page's scrollable height
   *   is unchanged (settled: loaded but shorter, or the post never came). That is a FALLBACK to the
   *   raw offset, logged as one naming the anchor.
   * A skeleton on screen pauses the loop; the next change restarts it.
   */
  let looping = false;
  let confirmed = 0;
  let steady = 0;
  let lastHeight = 0;
  function frame() {
    if (!isActiveRestore(stop)) {
      looping = false;
      return;
    }
    if (placeholderShown(scroller)) {
      looping = false;
      return;
    }
    if (reached()) {
      const el = resolveAnchor();
      if (anchor && el) {
        const drift =
          el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
        if (Math.abs(drift) < 1) confirmed += 1;
        else {
          confirmed = 0;
          apply('content moved');
        }
        if (confirmed >= 2) {
          looping = false;
          stop();
          return;
        }
      }
    } else if (following) {
      looping = false;
      Log.d(
        'scrollMemory',
        `entry ${key}: the anchor left the page after it was aligned, restore ended`
      );
      stop();
      return;
    } else {
      const height = scroller.scrollHeight;
      steady = height === lastHeight ? steady + 1 : 0;
      lastHeight = height;
      if (steady >= 2) {
        looping = false;
        stop();
        if (anchor) {
          Log.w(
            'scrollMemory',
            `entry ${key}: anchor ${anchor.id} never appeared (post gone, re-ranked or beyond the loaded page), the raw offset ${target}px is used`
          );
        }
        apply('page settled shorter');
        return;
      }
    }
    requestAnimationFrame(frame);
  }
  function settle() {
    if (placeholderShown(scroller)) return;
    steady = 0;
    if (reached()) {
      watch(anchorEl);
      watch(anchorEl?.parentElement);
      apply('content ready');
      if (!anchor) {
        stop();
        return;
      }
      if (!following) confirmed = 0;
      following = true;
    }
    if (!looping) {
      looping = true;
      lastHeight = scroller.scrollHeight;
      requestAnimationFrame(frame);
    }
  }
  scroller.addEventListener('scroll', userScrolled, { passive: true });
  // A key aimed at the document (focus on the body) never reaches the box.
  document.addEventListener('keydown', documentKey, { passive: true });
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
