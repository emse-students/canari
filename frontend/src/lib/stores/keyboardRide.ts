/**
 * THE COMPOSER AND THE THREAD RIDE DOWN WITH A FALLING KEYBOARD, ON iOS
 * (docs/wiki/frontend/keyboard-and-send-motion.md, section 5).
 *
 * Messenger iOS keeps its composer on the keys while they fall and scrolls the thread with it. Canari
 * relays out full height on the fall's first frame, so its composer jumped to the bottom and the keys
 * slid off over it (iPhone 12, 2026-11-13). The shell (`canari_ios.mm`, `CanariHandKeyboardFallToPage`)
 * now announces the fall BEFORE resizing the WebView, with the keyboard's own duration and curve read
 * from `UIKeyboardAnimationDurationUserInfoKey` / `CurveUserInfoKey`. The page records where its riding
 * pieces stand, lays itself out full height on the resize as before, and starts each piece from where
 * it stood, translated back, to its new place - a compositor transform, over the keyboard's timing.
 *
 * This module is the pure half: what the shell may send, the CSS easing of a UIKit curve, and the
 * keyframes. `keyboardViewport.svelte.ts` wires it to the DOM.
 */

/** What `window.canariKeyboardFall` receives: the keyboard animation's own parameters. */
export type KeyboardFallSpec = {
  /** `UIKeyboardAnimationDurationUserInfoKey`, in ms. */
  durationMs: number;
  /** `UIKeyboardAnimationCurveUserInfoKey`, a `UIViewAnimationCurve` raw value. */
  curve: number;
};

/**
 * The CSS easing standing for UIKit's keyboard curve, raw value 7.
 *
 * 7 is not a public `UIViewAnimationCurve`: it is the keyboard's own, which UIKit applies when it is
 * passed back through `options: curve << 16` and which has no published definition. This bezier is the
 * one the ecosystem settled on for it; it is NOT measured here, and the reading owed in the wiki (the
 * composer's gap to the keys' top, frame by frame, on a fall) is what confirms or replaces it. ONE
 * place names it.
 */
export const UIKIT_KEYBOARD_CURVE_EASING = 'cubic-bezier(0.38, 0.7, 0.125, 1)';

/**
 * The CSS easing of a `UIViewAnimationCurve` raw value, or null for a value UIKit does not define here
 * (the caller then does not ride and says so - riding on a guessed curve is the defect this replaces).
 */
export function uikitCurveEasing(curve: number): string | null {
  switch (curve) {
    case 0:
      return 'ease-in-out';
    case 1:
      return 'ease-in';
    case 2:
      return 'ease-out';
    case 3:
      return 'linear';
    case 7:
      return UIKIT_KEYBOARD_CURVE_EASING;
    default:
      return null;
  }
}

/**
 * Parses what the shell passed: `{ durationMs, curve }` with a positive finite duration and an integer
 * curve, or null for anything else (the caller logs it and answers `false`, and the shell just resizes).
 */
export function parseKeyboardFall(value: unknown): KeyboardFallSpec | null {
  if (typeof value !== 'object' || value === null) return null;
  const { durationMs, curve } = value as Record<string, unknown>;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0)
    return null;
  if (typeof curve !== 'number' || !Number.isInteger(curve)) return null;
  return { durationMs, curve };
}

/** A move smaller than this is no move: rounding between two reads of the same box. */
const RIDE_MIN_PX = 1;

/**
 * How far the riding pieces moved down when the page went full height - the anchor's new top minus
 * the top captured before the resize - or null when that is no move at all (nothing to ride).
 */
export function rideDistancePx(topBefore: number, topAfter: number): number | null {
  const distance = topAfter - topBefore;
  return distance > RIDE_MIN_PX ? distance : null;
}

/**
 * The keyframes of one riding piece: from where it stood (its new place, translated back up by the
 * distance) to its new place. Ending on `none` leaves no transform behind, so a ride cut short leaves
 * the piece as its own style.
 */
export function rideKeyframes(distancePx: number): Keyframe[] {
  return [{ transform: `translateY(${-distancePx}px)` }, { transform: 'none' }];
}

/**
 * Whether a scroll container was resting on its last row when the fall was announced: only then does
 * its content move down with the composer (the thread keeps a reader at the bottom pinned there), so
 * only then does it ride. A reader scrolled up stays where they are, as in Messenger.
 */
export function restsAtBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number
): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= 2;
}

/** Dispatched on `window` when a ride starts; `detail.finished` settles when every piece has landed. */
export const KEYBOARD_RIDE_EVENT = 'canari:keyboard-ride';

/** What a ride needs from the moment the fall was announced, before the page went full height. */
export type KeyboardRideCapture = {
  /** The piece whose move IS the ride's distance: the composer band. */
  anchor: HTMLElement;
  /** Its top before the resize, in CSS px. */
  anchorTop: number;
  /** Every piece that rides: the anchor, and each scroll container that rested on its last row. */
  riders: HTMLElement[];
  durationMs: number;
  easing: string;
};

/**
 * Records the riding pieces under `root` as they stand NOW, before the resize: the one
 * `[data-keyboard-ride="anchor"]` and every `[data-keyboard-ride="when-at-bottom"]` resting on its
 * last row. Null when the screen has no anchor - it has no composer, so nothing rides.
 */
export function captureKeyboardRide(
  root: ParentNode,
  spec: KeyboardFallSpec,
  easing: string
): KeyboardRideCapture | null {
  const anchor = root.querySelector<HTMLElement>('[data-keyboard-ride="anchor"]');
  if (!anchor) return null;
  const riders = [anchor];
  for (const el of root.querySelectorAll<HTMLElement>('[data-keyboard-ride="when-at-bottom"]')) {
    if (restsAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight)) riders.push(el);
  }
  return {
    anchor,
    anchorTop: anchor.getBoundingClientRect().top,
    riders,
    durationMs: spec.durationMs,
    easing,
  };
}

/**
 * Starts the ride once the page has its full-height layout: every captured piece from where it stood
 * to its new place, over the keyboard's duration and curve. Returns the distance ridden, or null when
 * the anchor did not move (or is gone) and there is nothing to ride.
 */
export function startKeyboardRide(capture: KeyboardRideCapture): number | null {
  if (!capture.anchor.isConnected) return null;
  const distance = rideDistancePx(capture.anchorTop, capture.anchor.getBoundingClientRect().top);
  if (distance === null) return null;
  const animations = capture.riders
    .filter((el) => el.isConnected)
    .map((el) =>
      el.animate(rideKeyframes(distance), {
        duration: capture.durationMs,
        easing: capture.easing,
      })
    );
  const finished = Promise.allSettled(animations.map((a) => a.finished));
  window.dispatchEvent(new CustomEvent(KEYBOARD_RIDE_EVENT, { detail: { finished } }));
  return distance;
}
