/**
 * Tells a single tap from a double tap on a surface where the two mean different things - a message
 * bubble (tap: the info panel, double tap: a heart), the media viewer (tap: the chrome, double tap:
 * zoom).
 *
 * THE SINGLE TAP WAITS EXACTLY AS LONG AS A SECOND TAP COULD STILL ARRIVE, AND NO LONGER. The first
 * tap arms ONE timer of `GESTURE.DOUBLE_TAP_MS`; a second tap inside that window (and within
 * `GESTURE.DOUBLE_TAP_SLOP_PX` of the first) cancels it and fires the double action alone. Without
 * the wait, both fire: the bubble used to open its info panel on the first tap and close it again on
 * the second, so a like always flashed the readers' panel (user report, 2026-10-12). The window is
 * the one `isDoubleTap` already reads, so the two surfaces cannot drift apart.
 *
 * A surface whose tap has no double meaning at that moment should not call this at all and act on
 * the tap immediately: the wait is only paid where a second tap would change the answer.
 */

import { GESTURE, isDoubleTap, type Sample } from './viewerGestures';

/** The two outcomes of a tap sequence; exactly one of them runs per sequence. */
export interface TapHandlers {
  /** The window passed with no second tap. */
  onSingle: (tap: Sample) => void;
  /** A second tap landed inside the window; the pending single tap was cancelled. */
  onDouble: (tap: Sample) => void;
}

/** A per-surface disambiguator: feed it every tap, cancel it on teardown. */
export interface TapDisambiguator {
  /** Records a tap. `tap.t` is any monotonic clock in ms (an event's `timeStamp`, `Date.now()`). */
  tap: (tap: Sample) => void;
  /** Drops a pending single tap without running it (teardown, or a gesture that superseded it). */
  cancel: () => void;
  /** True while a single tap is waiting for the window to close. */
  pending: () => boolean;
}

/**
 * Builds a disambiguator around one timer. The handlers are read at call time, so a component may
 * pass closures over its current props.
 */
export function createTapDisambiguator(handlers: TapHandlers): TapDisambiguator {
  let lastTap: Sample | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancel() {
    if (timer) clearTimeout(timer);
    timer = null;
    lastTap = null;
  }

  function tap(sample: Sample) {
    if (timer && isDoubleTap(lastTap, sample)) {
      cancel();
      handlers.onDouble(sample);
      return;
    }
    // A tap too far (in time or space) from a pending one closes that one first: it was single.
    if (timer && lastTap) {
      const previous = lastTap;
      cancel();
      handlers.onSingle(previous);
    }
    lastTap = sample;
    timer = setTimeout(() => {
      const single = lastTap;
      timer = null;
      lastTap = null;
      if (single) handlers.onSingle(single);
    }, GESTURE.DOUBLE_TAP_MS);
  }

  return { tap, cancel, pending: () => timer !== null };
}

/** What, inside a tappable surface, owns its own tap: a link, a button, a form control. */
const OWN_TAP_SELECTOR =
  'a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"], [contenteditable="true"]';

/**
 * True when `target` sits inside an interactive element nested in `surface` (the surface itself
 * excluded, since a bubble is a `role="button"`). Such a tap belongs to that element: it acts
 * immediately and must never count towards the surface's double tap - two quick taps on a poll
 * option are two votes, not a heart.
 */
export function tapBelongsToInnerControl(target: EventTarget | null, surface: Element): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const owner = (target as Element).closest(OWN_TAP_SELECTOR);
  return owner !== null && owner !== surface && surface.contains(owner);
}
