/**
 * THE COMPOSER AND THE THREAD RIDE DOWN WITH A FALLING KEYBOARD, ON iOS
 * (docs/wiki/frontend/keyboard-and-send-motion.md, section 5).
 *
 * Messenger iOS keeps its composer on the keys while they fall and scrolls the thread with it. Canari
 * relays out full height on the fall's first frame, so its composer jumped to the bottom and the keys
 * slid off over it (iPhone 12, 2026-11-13). The shell (`canari_ios.mm`, `CanariHandKeyboardFallToPage`)
 * now announces the fall BEFORE resizing the WebView, with the keyboard's own duration and curve read
 * from `UIKeyboardAnimationDurationUserInfoKey` / `CurveUserInfoKey`. The page records where each
 * riding piece stands, lays itself out full height on the resize as before, and - once every layout
 * reaction to the resize has run - starts each piece that MOVED from where it stood, translated back by
 * its own move, to its new place: a compositor transform, over the keyboard's timing.
 *
 * WHILE A PIECE RIDES IT IS A CONTAINING BLOCK: a transform makes an element the containing block of
 * its `position: fixed` descendants, so for the ride's ~250 ms a fixed panel inside the composer band
 * or the thread would be placed against the piece, not the screen. The ride is cancelled - every piece
 * jumps to its place - on any pointer press and on any rise, which is how a picker opens.
 *
 * `keyboardViewport.svelte.ts` owns the state and wires the hooks; this module holds the decisions and
 * the DOM steps, each testable on its own.
 */

/** What `window.canariKeyboardFall` receives: the keyboard animation's own parameters. */
export type KeyboardFallSpec = {
  /** `UIKeyboardAnimationDurationUserInfoKey`, in ms. */
  durationMs: number;
  /** `UIKeyboardAnimationCurveUserInfoKey`, a `UIViewAnimationCurve` raw value. */
  curve: number;
  /** The keyboard's overlap with the WebView before the fall, in CSS px (a point). */
  fromPx: number;
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
 * Parses what the shell passed: `{ durationMs, curve, fromPx }` with a finite non-negative duration
 * and overlap and an integer curve, or null for anything else (the caller logs it and answers `false`,
 * and the shell just resizes).
 */
export function parseKeyboardFall(value: unknown): KeyboardFallSpec | null {
  if (typeof value !== 'object' || value === null) return null;
  const { durationMs, curve, fromPx } = value as Record<string, unknown>;
  const finiteNonNegative = (n: unknown): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!finiteNonNegative(durationMs) || !finiteNonNegative(fromPx)) return null;
  if (typeof curve !== 'number' || !Number.isInteger(curve)) return null;
  return { durationMs, curve, fromPx };
}

/** Why a fall is not ridden: `silent` is ordinary use, `warn` is a broken contract. */
export type FallRefusal = { level: 'silent' | 'warn'; why: string };

/**
 * Whether an announced fall is ridden, and if not, whether that is worth a WARN.
 *
 * Silent: an instant fall (no animation to ride), a keyboard too short to have opened the page (a
 * hardware keyboard's shortcut bar - the shell filters it first, this is the page's own reading of the
 * same fact), reduced motion. WARN: a curve UIKit does not define, or a page already full height when
 * the announcement arrives - the shell sends it BEFORE resizing, so that means the order broke.
 */
export function fallRefusal(
  spec: KeyboardFallSpec,
  ctx: { easing: string | null; reducedMotion: boolean; isOpen: boolean; openThresholdPx: number }
): FallRefusal | null {
  if (spec.durationMs === 0) return { level: 'silent', why: 'an instant fall' };
  if (spec.fromPx < ctx.openThresholdPx)
    return { level: 'silent', why: `a ${spec.fromPx}px keyboard never opened the page` };
  if (ctx.reducedMotion) return { level: 'silent', why: 'reduced motion' };
  if (ctx.easing === null) return { level: 'warn', why: `UIKit curve ${spec.curve} has no easing` };
  if (!ctx.isOpen)
    return { level: 'warn', why: 'announced after the page went full height - the order broke' };
  return null;
}

/** A move smaller than this is no move: rounding between two reads of the same box. */
const RIDE_MIN_PX = 1;

/**
 * How far a piece moved down when the page went full height - its probe's new top minus the top
 * captured before the resize - or null when that is no move at all (that piece does not ride).
 */
export function rideDistancePx(topBefore: number, topAfter: number): number | null {
  const distance = topAfter - topBefore;
  return distance > RIDE_MIN_PX ? distance : null;
}

/**
 * The keyframes of one riding piece: from where it stood (its new place, translated back up by ITS
 * distance) to its new place. Ending on `none` leaves no transform behind, so a ride cut short leaves
 * the piece as its own style.
 */
export function rideKeyframes(distancePx: number): Keyframe[] {
  return [{ transform: `translateY(${-distancePx}px)` }, { transform: 'none' }];
}

/** Dispatched on `window` when a ride starts; `detail.finished` settles when every piece has landed. */
export const KEYBOARD_RIDE_EVENT = 'canari:keyboard-ride';

/** One piece that may ride: the element moved, and the element whose top says how far it moved. */
type Rider = { el: HTMLElement; probe: HTMLElement; topBefore: number };

/** What a ride needs from the moment the fall was announced, before the page went full height. */
export type KeyboardRideCapture = {
  riders: Rider[];
  durationMs: number;
  easing: string;
};

/**
 * The element whose top is a piece's position. `data-keyboard-ride="box"`: the piece itself (the
 * composer band). `data-keyboard-ride="last-row"`: its last child (the thread's newest row) - a scroll
 * container's box does not move when it grows, its CONTENT does, and only by what the bottom pin
 * actually scrolled: nothing for a thread shorter than its box, the overflow for one that overflows by
 * less than the keyboard.
 */
function probeOf(el: HTMLElement): HTMLElement {
  if (el.dataset.keyboardRide === 'last-row') {
    const last = el.lastElementChild;
    return last instanceof HTMLElement ? last : el;
  }
  return el;
}

/**
 * Records every `[data-keyboard-ride]` piece under `root` as it stands NOW, before the resize. Null
 * when the screen has none - nothing to ride.
 */
export function captureKeyboardRide(
  root: ParentNode,
  durationMs: number,
  easing: string
): KeyboardRideCapture | null {
  const riders: Rider[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[data-keyboard-ride]')) {
    const probe = probeOf(el);
    riders.push({ el, probe, topBefore: probe.getBoundingClientRect().top });
  }
  return riders.length > 0 ? { riders, durationMs, easing } : null;
}

/** A started ride: its animations (cancellable) and the distance each piece rides. */
export type KeyboardRide = { animations: Animation[]; distances: number[] };

/**
 * Starts the ride once the page has its full-height layout AND every reaction to it (the thread's
 * bottom pin) has run: each captured piece that moved rides from where it stood by ITS OWN move, over
 * the keyboard's duration and curve. A piece that did not move, or is gone, does not ride. Null when
 * none moved.
 */
export function startKeyboardRide(capture: KeyboardRideCapture): KeyboardRide | null {
  const animations: Animation[] = [];
  const distances: number[] = [];
  for (const { el, probe, topBefore } of capture.riders) {
    if (!el.isConnected || !probe.isConnected) continue;
    const distance = rideDistancePx(topBefore, probe.getBoundingClientRect().top);
    if (distance === null) continue;
    distances.push(distance);
    animations.push(
      el.animate(rideKeyframes(distance), { duration: capture.durationMs, easing: capture.easing })
    );
  }
  if (animations.length === 0) return null;
  const finished = Promise.allSettled(animations.map((a) => a.finished));
  window.dispatchEvent(new CustomEvent(KEYBOARD_RIDE_EVENT, { detail: { finished } }));
  return { animations, distances };
}

/**
 * Runs `start` once every layout reaction to the resize that is happening has run, before that frame
 * is painted - a `ResizeObserver` created NOW: its first notification is delivered in the next
 * rendering update, after layout, and after every observer created before it (the spec delivers them
 * in creation order), so after the thread's bottom pin (`threadGrowthObserver`). The transforms
 * started there are in that frame's paint, so no frame shows the pieces at their new place first.
 */
export function afterLayoutReactions(targets: Element[], start: () => void): () => void {
  let done = false;
  const observer = new ResizeObserver(() => {
    if (done) return;
    done = true;
    observer.disconnect();
    start();
  });
  for (const t of targets) observer.observe(t);
  return () => {
    done = true;
    observer.disconnect();
  };
}

/**
 * Follows rides frame by frame for a consumer that must re-read a riding piece (the native "+" twin):
 * `onFrame` on every animation frame from a ride's start until the LATEST ride has settled, then once
 * more. A second ride started while one runs extends the loop to ITS end - an earlier ride settling
 * does not stop it. The loop's end is the animations' own end, never a counted duration.
 */
export function followKeyboardRides(
  onFrame: () => void,
  raf: (cb: () => void) => unknown = (cb) => requestAnimationFrame(cb)
): { onRide: (finished: Promise<unknown>) => void; stop: () => void } {
  let latest = 0;
  let running = false;
  const frame = () => {
    if (!running) return;
    onFrame();
    raf(frame);
  };
  return {
    onRide(finished) {
      const mine = ++latest;
      if (!running) {
        running = true;
        raf(frame);
      }
      void finished.then(() => {
        if (mine !== latest) return;
        running = false;
        onFrame();
      });
    },
    stop() {
      latest++;
      running = false;
    },
  };
}
