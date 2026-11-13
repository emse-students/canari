/**
 * The observers that keep a thread's reader in place while its content changes size - taken out of
 * `ChatArea` so a real browser can drive them without mounting the whole pane (the media-frame
 * bench, docs/wiki/frontend/media-frame.md). The judgements are `threadAnchor.ts`'s; this is only
 * the wiring that feeds them the numbers.
 */
import {
  anchorShift,
  appendGlidePx,
  firstRowBelow,
  threadGrowthResponse,
  threadReach,
} from './threadAnchor';
import { Log } from '$lib/utils/Log';

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

  let previousClientHeight = scroller.clientHeight;
  const glide = createThreadGlide(scroller);
  /**
   * `added`: the elements this change inserted, whose bubbles wait out a glide that makes room for
   * them (`.motion-bubble-in[data-glide-entrance]`) - a bubble that arrives without one fades at once.
   */
  const follow = (cause: 'rows' | 'box', added: readonly Element[] = []) => {
    // A GLIDE IN FLIGHT IS TAKEN OFF THE ROWS BEFORE ANYTHING IS MEASURED (review of #3490, B1).
    // A transformed row counts in the scroller's scrollable overflow - measured in Chrome 2026-11-13:
    // `scrollHeight` grows by `max(0, offset - padding-bottom)` - so a pin to `scrollHeight` during
    // a glide went past the real bottom by the row's remaining offset and the rows rose too far,
    // then dropped back when the glide ended. With the transforms removed every number below is the
    // layout's; the glide is then put back exactly where it was drawn (same keyframes, same time
    // into it), so no frame shows the difference. The state is the running animation itself.
    const held = glide.suspend();
    const now = state();
    const scrollTopBefore = scroller.scrollTop;
    const currentReach = threadReach(scroller);
    const response = threadGrowthResponse({
      previousReach,
      currentReach,
      wasNearBottom: now.wasNearBottom,
      isLoadingOlder: now.isLoadingOlder,
      isEntering: now.isEntering,
    });
    // THE ROW ANCHOR IS FOR A READER IN HISTORY ONLY: for one at the bottom, keeping the top row in
    // place is what scrolled the thread up when a `svh`-capped photo shrank under the keyboard.
    const shift =
      response === 'keep-row'
        ? anchorShift({
            previousTop: anchor?.top ?? null,
            currentTop: anchor?.row.isConnected ? anchor.row.offsetTop : null,
            isEntering: now.isEntering,
          })
        : 0;
    previousReach = currentReach;
    let travel = 0;
    if (response === 'follow-bottom') {
      scroller.scrollTop = scroller.scrollHeight;
      travel = appendGlidePx({
        cause,
        previousScrollTop: scrollTopBefore,
        currentScrollTop: scroller.scrollTop,
        previousClientHeight,
        currentClientHeight: scroller.clientHeight,
        isEntering: now.isEntering,
        reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
      });
    }
    // `loadOlderGroups` also restores the IndexedDB page's position, by absolute assignment after
    // its own `await tick()`. That assignment is computed from its own captured `scrollTop` and
    // therefore lands on the same pixel whether or not this ran first - it cannot double-count.
    else if (shift !== 0) scroller.scrollTop += shift;
    // TWO ARRIVALS INSIDE ONE GLIDE (S5): the new glide starts where the rows are DRAWN - what the
    // running one had left to travel, plus the new row - so nothing jumps. Otherwise the held glide
    // resumes as it was.
    if (travel > 0) {
      if (glide.play(glideTravel(held, travel))) markGlideEntrance(added);
    } else if (held) glide.play(held.px, held.time);
    previousClientHeight = scroller.clientHeight;
    captureAnchor();
  };

  const boxes = new ResizeObserver(() => follow('box'));
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
    const added: Element[] = [];
    for (const record of records) {
      for (const node of record.addedNodes) if (node instanceof Element) added.push(node);
    }
    follow('rows', added);
  });
  mutations.observe(scroller, { childList: true, subtree: true, characterData: true });
  if (composerBand) boxes.observe(composerBand);

  return () => {
    mutations.disconnect();
    boxes.disconnect();
    glide.stop();
    scroller.style.overflowAnchor = previousAnchoring;
  };
}

/** Reads a `--motion-*` duration token (`220ms`) as milliseconds, or null if it is not one. */
function motionMs(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)ms$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

/** Where a glide taken off the rows had drawn them. */
export interface HeldGlide {
  /** The distance the glide was started with. */
  px: number;
  /** How far below their place the rows were drawn: `px` times what was left of the curve. */
  remaining: number;
  /** Milliseconds into the glide, to resume it on the same frame of its curve. */
  time: number;
}

/** The distance a new arrival glides from: the held glide's drawn offset, plus the new row. */
export function glideTravel(held: HeldGlide | null, travel: number): number {
  return (held?.remaining ?? 0) + travel;
}

/** The thread's glide, as the durable state `follow` reads: see {@link createThreadGlide}. */
export interface ThreadGlide {
  /** Removes the glide's transforms so the layout can be measured; null when none was running. */
  suspend(): HeldGlide | null;
  /** Plays the rows from `px` below their place back to it, `time` ms in; false if nothing ran. */
  play(px: number, time?: number): boolean;
  /** Ends any glide (teardown). */
  stop(): void;
}

/**
 * The thread making room for an arrival as Messenger does (`appendGlidePx`): the rows, already at
 * their final place, are played from `px` lower back to it - a compositor transform on the motion
 * scale's `--motion-thread-glide` / `--motion-ease-in-out`, never a `scrollTop` animation. The
 * running animations ARE the state: `suspend` reads where they drew the rows from their own
 * computed timing (the eased progress) and cancels them; `play` starts them again. A glide that
 * ends clears itself on its `finish` event - no clock anywhere.
 */
export function createThreadGlide(scroller: HTMLElement): ThreadGlide {
  let running: { px: number; animations: Animation[] } | null = null;

  const suspend = (): HeldGlide | null => {
    const current = running;
    if (!current) return null;
    running = null;
    const first = current.animations[0];
    const progress = first.effect?.getComputedTiming().progress ?? null;
    const time = Number(first.currentTime ?? 0);
    for (const animation of current.animations) animation.cancel();
    // A null progress is a glide past its end whose `finish` has not been delivered yet: nothing is
    // left to draw, and nothing to resume.
    if (progress === null) return null;
    return { px: current.px, remaining: current.px * (1 - progress), time };
  };

  const play = (px: number, time = 0): boolean => {
    if (px <= 0) return false;
    const root = getComputedStyle(document.documentElement);
    const duration = motionMs(root.getPropertyValue('--motion-thread-glide'));
    const easing = root.getPropertyValue('--motion-ease-in-out').trim();
    if (duration === null || !easing) {
      Log.w('threadGrowth', `glide of ${px}px skipped: the motion tokens did not resolve`);
      return false;
    }
    const animations: Animation[] = [];
    for (const child of scroller.children) {
      if (!(child instanceof HTMLElement) || typeof child.animate !== 'function') continue;
      const animation = child.animate(
        [{ transform: `translateY(${px}px)` }, { transform: 'none' }],
        { duration, easing }
      );
      if (time > 0) animation.currentTime = time;
      animations.push(animation);
    }
    if (animations.length === 0) return false;
    const run = { px, animations };
    running = run;
    animations[0].addEventListener('finish', () => {
      if (running === run) running = null;
    });
    if (time === 0) {
      Log.d('threadGrowth', `arrival: thread glides ${Math.round(px)}px over ${duration}ms`);
    }
    return true;
  };

  return { suspend, play, stop: () => void suspend() };
}

/**
 * Marks the bubbles among `added` as waiting out the glide that makes room for them
 * (`.motion-bubble-in[data-glide-entrance]`, app.css). Set in the same task as their mount, before
 * any frame, so the plain fade they started with is never seen.
 */
function markGlideEntrance(added: readonly Element[]): void {
  for (const node of added) {
    if (node.matches('.motion-bubble-in')) node.setAttribute('data-glide-entrance', '');
    for (const bubble of node.querySelectorAll('.motion-bubble-in')) {
      bubble.setAttribute('data-glide-entrance', '');
    }
  }
}
