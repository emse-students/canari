import { Log } from '$lib/utils/Log';
import { memoryFor, memoryOf } from './historyEntry';
import { PAGE_SCROLLER_SELECTOR } from './scrollToTop';

/**
 * A PAGE IS REOPENED WHERE IT WAS LEFT, WHEN THE READER GOES BACK TO IT (owner report, 2026-11-15:
 * Back from an association must land on the feed, and at the same post).
 *
 * SvelteKit restores the scroll of the WINDOW; this app's pages scroll inside ONE box
 * (`.page-scroll-wrap`, see `scrollToTop.ts`), so a Back landed on the top of the feed and the
 * reader lost their place in it. The layout records the box's offset against the HISTORY ENTRY as a
 * navigation leaves it ({@link rememberLeaving}; two `/posts` entries keep two offsets) and puts it
 * back on a history Back or Forward ({@link restoreOnReturn}) - never on a link, which opens a page
 * at its top.
 *
 * A feed draws after the page is on screen, so the offset may not exist yet, and a skeleton is as tall
 * as the cards it stands for. The restore therefore applies the offset only once the box is tall
 * enough AND shows no placeholder (the app's one skeleton convention is `animate-pulse`), and it
 * ENDS at the first of, all events and none a clock: the offset applied; the first change of the
 * page after which no placeholder is left AND two frames pass with no further change (it has
 * settled: applied, clamped by the browser when the page came back shorter); ANY scroll event while it waits (it never scrolls the box before it
 * applies, so such an event is the reader's - wheel, touch, key, scrollbar drag alike); or the next
 * navigation ({@link cancelRestore}). Changes are watched by a ResizeObserver on the box and a
 * MutationObserver on its subtree, so late-mounted children are seen without re-observing.
 */

/** Records where the page box was when the entry `key` was left. Zero is forgotten. */
export function rememberLeaving(key: number | undefined, top: number): void {
  if (key === undefined) return;
  const memory = memoryFor(key);
  if (top > 0) memory.top = Math.round(top);
  else delete memory.top;
}

/** The offset an entry was left at, if any. */
export function recallScroll(key: number | undefined): number | undefined {
  return memoryOf(key)?.top;
}

let stopRestore: (() => void) | null = null;

/** Ends a restore still waiting for its content: a navigation has begun. */
export function cancelRestore(): void {
  stopRestore?.();
  stopRestore = null;
}

/** Whether the box still shows a loading placeholder. */
function placeholderShown(scroller: HTMLElement): boolean {
  return scroller.querySelector('.animate-pulse, [aria-busy="true"]') !== null;
}

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
  if (!page || !target) return false;
  const scroller: HTMLElement = page;
  const tallEnough = () => scroller.scrollHeight - scroller.clientHeight >= target;
  const apply = (why: string) => {
    scroller.scrollTop = target;
    Log.d('scrollMemory', `entry ${key}: ${why}, restored to ${target}px`);
  };
  if (tallEnough() && !placeholderShown(scroller)) {
    apply('content ready');
    return true;
  }

  const resize = new ResizeObserver(() => settle());
  const mutation = new MutationObserver(() => settle());
  const userScrolled = () => {
    Log.d('scrollMemory', `entry ${key}: the reader scrolled, restore dropped`);
    stop();
  };
  function stop() {
    resize.disconnect();
    mutation.disconnect();
    scroller.removeEventListener('scroll', userScrolled);
    if (stopRestore === stop) stopRestore = null;
  }
  let changes = 0;
  /**
   * After a change: still loading, keep waiting; tall enough, apply and finish; loaded but shorter,
   * finish only after TWO animation frames with no further change - a feed mounts its cards a frame
   * at a time, so a page that is still growing keeps invalidating the check, and a page that has
   * stopped is the settled one (the browser then clamps the offset to what the page has).
   */
  function settle() {
    changes += 1;
    if (placeholderShown(scroller)) return;
    if (tallEnough()) {
      stop();
      apply('content ready');
      return;
    }
    const seen = changes;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (seen !== changes || stopRestore !== stop) return;
        stop();
        apply('page settled shorter');
      })
    );
  }
  scroller.addEventListener('scroll', userScrolled, { passive: true });
  resize.observe(scroller);
  mutation.observe(scroller, { childList: true, subtree: true });
  stopRestore = stop;
  Log.d('scrollMemory', `entry ${key}: waiting to reach ${target}px`);
  return true;
}
