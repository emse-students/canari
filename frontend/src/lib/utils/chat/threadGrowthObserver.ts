/**
 * The observers that keep a thread's reader in place while its content changes size - taken out of
 * `ChatArea` so a real browser can drive them without mounting the whole pane (the media-frame
 * bench, docs/wiki/frontend/media-frame.md). The judgements are `threadAnchor.ts`'s; this is only
 * the wiring that feeds them the numbers.
 */
import { anchorShift, firstRowBelow, shouldFollowThreadBottom, threadReach } from './threadAnchor';

/** What the pane knows about itself at the moment a change is observed. */
export interface ThreadGrowthState {
  /** Whether the reader was at the bottom BEFORE the change - see `ThreadGrowth.wasNearBottom`. */
  wasNearBottom: boolean;
  isLoadingOlder: boolean;
  isEntering: boolean;
}

/** The rows the anchor is chosen among. */
export const THREAD_ROW_SELECTOR = '[id^="msg-"]';

/**
 * Starts following `scroller`: growth below a reader at the bottom is followed, any change above
 * the row at the top of the viewport is undone. Returns the teardown.
 *
 * **FOUR TRIGGERS, ONE CLOSURE, ONE QUANTITY.** The pane changes size from its content (a row added
 * or re-laid out: the `MutationObserver`), from a CHILD's box (a medium decoding to its size, which
 * is not a mutation), from its own box (the soft keyboard, a resize, a panel opening) or from the
 * composer band, whose measured height is the scroller's `padding-bottom`. All four ask `follow()`
 * the same question about the same number. No timer: every trigger is the change itself.
 */
export function observeThreadGrowth(
  scroller: HTMLElement,
  state: () => ThreadGrowthState,
  composerBand?: HTMLElement | null
): () => void {
  // THIS IS THE ONLY ANCHOR, IN EVERY ENGINE - so the browser's own is switched off. Chromium (and
  // Safari from 27) anchor a scroller natively: measured on the media-frame bench, 2026-10-02, an old
  // video above the reader grew by 272 px, Chromium had already moved `scrollTop` by 272 when the
  // observer ran, and this added 272 more - the reader's row left by 253 px UPWARD. WebKit before 27
  // has no native anchoring at all, so leaving it on would make the same code right on an iPhone
  // and wrong on an Android phone. One mechanism, identical everywhere: this one.
  const previousAnchoring = scroller.style.overflowAnchor;
  scroller.style.overflowAnchor = 'none';
  // THE REACH, NOT THE HEIGHT: the bottom also moves when the pane's own box shrinks under
  // unchanged content (the soft keyboard rising) - see `threadReach`.
  let previousReach = threadReach(scroller);
  /**
   * THE ROW AT THE TOP OF THE VIEWPORT, and where it was the last time this fired (2026-10-02).
   *
   * `scrollTop` cannot tell a prepend from an append - both grow `scrollHeight` and leave
   * `scrollTop` alone - so a ROW is kept and asked how far it moved. It was the topmost RENDERED
   * row, which a prepend moves exactly as much as the reader's row; but a medium settling BETWEEN
   * the two moved only what the reader was looking at, and the old anchor, above it, reported
   * nothing.
   */
  let anchor: { row: HTMLElement; top: number } | null = null;
  const captureAnchor = () => {
    const rows = scroller.querySelectorAll<HTMLElement>(THREAD_ROW_SELECTOR);
    const viewportTop = scroller.getBoundingClientRect().top;
    const index = firstRowBelow(
      rows.length,
      (i) => rows[i].getBoundingClientRect().bottom,
      viewportTop
    );
    const row = index >= 0 ? rows[index] : null;
    anchor = row ? { row, top: row.offsetTop } : null;
  };
  captureAnchor();

  const follow = () => {
    const now = state();
    const currentReach = threadReach(scroller);
    const shouldFollow = shouldFollowThreadBottom({
      previousReach,
      currentReach,
      wasNearBottom: now.wasNearBottom,
      isLoadingOlder: now.isLoadingOlder,
      isEntering: now.isEntering,
    });
    const shift = shouldFollow
      ? 0
      : anchorShift({
          previousTop: anchor?.top ?? null,
          currentTop: anchor?.row.isConnected ? anchor.row.offsetTop : null,
          isEntering: now.isEntering,
        });
    previousReach = currentReach;
    if (shouldFollow) scroller.scrollTop = scroller.scrollHeight;
    // `loadOlderGroups` also restores the IndexedDB page's position, by absolute assignment after
    // its own `await tick()`. That assignment is computed from its own captured `scrollTop` and
    // therefore lands on the same pixel whether or not this ran first - it cannot double-count.
    else if (shift !== 0) scroller.scrollTop += shift;
    captureAnchor();
  };

  const boxes = new ResizeObserver(follow);
  boxes.observe(scroller);
  // EVERY CHILD'S BOX, because a medium decoding to its size is not a DOM mutation. An `<img>`
  // growing from 0 px when its GIF arrived changed no node and not the scroller's own box, so the
  // last message slid under the composer and nothing re-pinned it. `MediaFrame` reserves the size of
  // every new medium, which makes this rare - an old message taking its measured ratio once - and
  // this is what keeps that once from moving the reader. `observe` is idempotent, so the children
  // are re-enrolled on every mutation.
  const observeChildren = () => {
    for (const child of scroller.children) boxes.observe(child);
  };
  observeChildren();
  const mutations = new MutationObserver((records) => {
    // A child that left the pane is released, or the observer would hold every row ever rendered.
    for (const record of records) {
      if (record.target !== scroller) continue;
      for (const node of record.removedNodes) {
        if (node instanceof Element) boxes.unobserve(node);
      }
    }
    observeChildren();
    follow();
  });
  mutations.observe(scroller, { childList: true, subtree: true, characterData: true });
  if (composerBand) boxes.observe(composerBand);

  return () => {
    mutations.disconnect();
    boxes.disconnect();
    scroller.style.overflowAnchor = previousAnchoring;
  };
}
