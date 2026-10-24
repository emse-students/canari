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
 * A SECOND TAP TOO FAR AWAY (in space; a late one finds no timer) REPLACES the pending one: the
 * single action runs ONCE, for the new tap, when its own window closes. That is what the media viewer
 * always did, and it is right for the bubble too - settling the first as single and then the second
 * would toggle the info panel open and shut within a quarter second, the very flash this removes.
 *
 * `quietAfterDouble`: a completed double tap CONSUMES its window, so a third quick tap is ignored
 * outright - no second double, and no pending single that would open the panel after a heart. The
 * bubble asks for it; the viewer does not (a third tap there still starts a fresh sequence, as before).
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

/** How a surface wants the edges of a sequence handled. */
export interface TapOptions {
  /** Ignore every tap inside the window that follows a completed double tap. Default false. */
  quietAfterDouble?: boolean;
}

/** A per-surface disambiguator: feed it every tap, cancel it on teardown. */
export interface TapDisambiguator {
  /**
   * Records a tap. `tap.t` is the event's `timeStamp` - when the tap HAPPENED. A clock read in the
   * handler counts the previous tap's handling into the gap, so a real double tap on a busy phone
   * reads as two singles. One surface feeds one clock; never mix two.
   */
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
export function createTapDisambiguator(
  handlers: TapHandlers,
  options: TapOptions = {}
): TapDisambiguator {
  let lastTap: Sample | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** When the last double tap completed, while its window may still swallow taps. */
  let lastDouble: Sample | null = null;

  function cancel() {
    if (timer) clearTimeout(timer);
    timer = null;
    lastTap = null;
    lastDouble = null;
  }

  function tap(sample: Sample) {
    if (options.quietAfterDouble && lastDouble) {
      if (sample.t - lastDouble.t <= GESTURE.DOUBLE_TAP_MS) return;
      lastDouble = null;
    }
    if (timer && isDoubleTap(lastTap, sample)) {
      cancel();
      lastDouble = sample;
      handlers.onDouble(sample);
      return;
    }
    // A tap too far from a pending one REPLACES it: one single action, for the newer tap.
    if (timer) clearTimeout(timer);
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
