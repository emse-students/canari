/**
 * THE COMPOSER AND THE THREAD RIDE THE KEYBOARD: DOWN WITH IT ON iOS, BOTH WAYS ON ANDROID
 * (docs/wiki/frontend/keyboard-and-send-motion.md).
 *
 * ANDROID (2026-11-14): the WebView is never resized for the keyboard. The shell announces every
 * change of the keyboard's inset with the animation's duration and its interpolator sampled to points
 * (`window.canariImeTarget({ px, durationMs, curve })`, `imeTarget.ts`); the page captures every
 * riding piece, lays itself out over the keyboard at once, and rides each piece from where it stood to
 * its new place on a CSS `linear()` easing built from those points ({@link linearEasing}) - up on a
 * rise, down on a fall. The thread rides its ROWS ({@link captureKeyboardRide}'s `lastRow: 'rows'`),
 * never its box: the box keeps its height (its room for the keyboard is its bottom padding), so
 * riding it would open a gap under the header on a rise.
 *
 * iOS (section 5):
 * Messenger iOS keeps its composer on the keys while they fall and scrolls the thread with it. Canari
 * relays out full height on the fall's first frame, so its composer jumped to the bottom and the keys
 * slid off over it (iPhone 12, 2026-11-13). The shell (`canari_ios.mm`, `CanariHandKeyboardFallToPage`)
 * now announces the fall BEFORE resizing the WebView, with the keyboard's own duration and curve read
 * from `UIKeyboardAnimationDurationUserInfoKey` / `CurveUserInfoKey`. The page records where each
 * riding piece stands, lays itself out full height on the resize as before, and - once every layout
 * reaction to the resize has run - starts each piece that MOVED from where it stood, translated back by
 * its own move, to its new place: a compositor transform, over the keyboard's timing.
 *
 * THE ANDROID RIDE RUNS ON THE KEYBOARD'S TIMELINE, NOT FROM ITS OWN START (review of #3556, D1). The
 * announcement arrives 2-10 ms after `onPrepare`, as the keys start moving; the ride can only start
 * once the layout reactions have run, a frame or more later (60-75 ms on the Mi 9T), and starting it
 * from 0 then left the composer under the keys on the rise and a band of nothing on the fall, the
 * thread landing ~70 ms after the keyboard. So the capture carries the arrival time and each ride
 * animation's `startTime` IS that arrival: whatever frame it is first drawn in, it is drawn at the
 * keyboard's phase in that frame, and both end together. (A negative `delay` measured when the ride is
 * created was a frame late: a pending animation starts on the NEXT frame, from 0 plus the delay.)
 * `document.timeline` and `performance.now` share their origin, the document's time origin, and the
 * arrival is taken on the latter. A ride that could only start after the keyboard landed does not
 * animate at all. The animation's own end is still its termination; the clock only says WHERE in a
 * known animation the first frame is.
 *
 * WHILE A PIECE RIDES IT IS A CONTAINING BLOCK: a transform makes an element the containing block of
 * its `position: fixed` descendants, so for the ride's ~250 ms a fixed panel inside the composer footer
 * or the thread would be placed against the piece, not the screen. The ride is cancelled - every piece
 * jumps to its place - on any pointer press, on any iOS rise and on any new Android announcement,
 * which is how a picker opens.
 *
 * `keyboardViewport.svelte.ts` owns the state and wires the hooks; this module holds the decisions and
 * the DOM steps, each testable on its own.
 */

import { attachThreadRide, takeThreadGlideOff } from '$lib/utils/chat/threadGrowthObserver';
import { Log } from '$lib/utils/Log';

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
 * How far a piece moved when the page took its new layout - its probe's new BOTTOM edge minus the one
 * captured before ({@link rideEdgeOf}) - SIGNED: positive down (a fall), negative up (an Android
 * rise). Null when that is no move at all (that piece does not ride).
 */
export function rideDistancePx(edgeBefore: number, edgeAfter: number): number | null {
  const distance = edgeAfter - edgeBefore;
  return Math.abs(distance) > RIDE_MIN_PX ? distance : null;
}

/** The fewest and the most points a keyboard curve may carry (the shell sends 24). */
const CURVE_MIN_POINTS = 2;
const CURVE_MAX_POINTS = 64;

/**
 * The CSS easing of a keyboard curve sampled by the Android shell: `linear(p0, p1, ...)`, the points
 * evenly spaced in time (Chromium 113+), which reproduces the system's interpolator at the shell's
 * sampling. Null for anything that is not 2 to 64 finite numbers - the caller then does not ride.
 * The string is built HERE, from numbers: no CSS ever crosses the bridge.
 */
export function linearEasing(points: unknown): string | null {
  if (!Array.isArray(points)) return null;
  if (points.length < CURVE_MIN_POINTS || points.length > CURVE_MAX_POINTS) return null;
  if (!points.every((p) => typeof p === 'number' && Number.isFinite(p))) return null;
  return `linear(${(points as number[]).map((p) => String(Math.round(p * 10000) / 10000)).join(', ')})`;
}

/**
 * The keyframes of one riding piece: from where it stood (its new place, translated back by ITS
 * distance) to its new place. Ending on `none` leaves no transform behind, so a ride cut short leaves
 * the piece as its own style.
 */
export function rideKeyframes(distancePx: number): Keyframe[] {
  return [{ transform: `translateY(${-distancePx}px)` }, { transform: 'none' }];
}

/** Dispatched on `window` when a ride starts; `detail.finished` settles when every piece has landed. */
export const KEYBOARD_RIDE_EVENT = 'canari:keyboard-ride';

/**
 * What moves when a `last-row` piece rides: the scroller's BOX (the iOS fall, unchanged since #3492)
 * or its ROWS, the scroller's children, as `createThreadGlide` moves them (the Android ride, whose
 * scroller keeps its height).
 */
export type LastRowRide = 'box' | 'rows';

/**
 * One piece that may ride: the element, the element whose edge says how far it moved, and whether its
 * children move rather than itself.
 */
type Rider = { el: HTMLElement; probe: HTMLElement; edgeBefore: number; rows: boolean };

/**
 * The edge a piece rides by: its probe's BOTTOM, as drawn (`getBoundingClientRect` includes a
 * transform).
 *
 * THE BOTTOM, BECAUSE THE KEYBOARD PUSHES FROM BELOW (second review of #3556). A piece that keeps its
 * height moves its top and its bottom by the same distance - the composer footer, the thread's newest
 * row - so for it the two edges ride identically. A piece that also SHRINKS does not: the comments
 * drawer's `max-height` subtracts the keyboard (60dvh, ~567 px, against a cap of ~510 on the Mi 9T),
 * so its top rises 57 px less than its bottom. Ridden by its top, its bottom stood ~57 px above the
 * keys on the rise's first frame, the scrim showing under it. Ridden by its bottom, its bottom is on
 * the keys on every frame, and only its new height shows from the start - a sheet that was cut by the
 * cap at its new place.
 */
export function rideEdgeOf(probe: Element): number {
  return probe.getBoundingClientRect().bottom;
}

/** What a ride needs from the moment the fall was announced, before the page went full height. */
export type KeyboardRideCapture = {
  riders: Rider[];
  durationMs: number;
  easing: string;
  /**
   * When the keyboard started moving, on the clock `startKeyboardRide` is given: the Android
   * announcement's arrival. Null for the iOS fall, whose ride starts with the resize it waits for.
   */
  announcedAt: number | null;
};

/**
 * The element whose edge is a piece's position. `data-keyboard-ride="box"`: the piece itself (the
 * composer footer). `data-keyboard-ride="last-row"`: its last child (the thread's newest row) - a scroll
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
 * Records every `[data-keyboard-ride]` piece under `root` where it is DRAWN now, before the layout
 * changes - a transform still on it (a ride, a glide) included. Null when the screen has none -
 * nothing to ride. READS ONLY: the caller reads everything it needs first, then writes
 * (`releaseThreadGlides`, its layout), so no read here forces a style pass another write dirtied.
 *
 * @param announcedAt when the keyboard started moving, or null - see {@link KeyboardRideCapture}.
 */
export function captureKeyboardRide(
  root: ParentNode,
  durationMs: number,
  easing: string,
  lastRow: LastRowRide = 'box',
  announcedAt: number | null = null
): KeyboardRideCapture | null {
  const riders: Rider[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[data-keyboard-ride]')) {
    const probe = probeOf(el);
    const rows = lastRow === 'rows' && el.dataset.keyboardRide === 'last-row';
    riders.push({ el, probe, edgeBefore: rideEdgeOf(probe), rows });
  }
  return riders.length > 0 ? { riders, durationMs, easing, announcedAt } : null;
}

/**
 * Takes a thread's glide still in flight off the rows a capture will ride (`takeThreadGlideOff`),
 * AFTER their drawn edge was read: the ride then starts from where the reader saw them, and the
 * glide's transform is not left fighting the ride's on the same rows.
 */
export function releaseThreadGlides(capture: KeyboardRideCapture): void {
  for (const rider of capture.riders) {
    if (rider.rows && takeThreadGlideOff(rider.el)) {
      Log.d('keyboardRide', 'a thread glide in flight was taken off its rows for the ride');
    }
  }
}

/** The elements a rider's ride animates: itself, or its children for a thread that rides its rows. */
function moversOf(rider: Rider): Element[] {
  return rider.rows ? Array.from(rider.el.children) : [rider.el];
}

/**
 * A started ride: its animations (cancellable), the distance each piece rides, and how far into the
 * keyboard's animation its first frame is (0 for the iOS fall).
 */
export type KeyboardRide = { animations: Animation[]; distances: number[]; phaseMs: number };

/**
 * How far into the keyboard's animation a ride starting now must start, in ms, or null when the
 * keyboard has already landed - nothing is left to ride, the pieces just stand at their place. 0 for
 * a capture with no arrival time (the iOS fall starts with its resize).
 */
export function ridePhaseMs(capture: KeyboardRideCapture, now: number): number | null {
  if (capture.announcedAt === null) return 0;
  const elapsed = Math.max(0, now - capture.announcedAt);
  return elapsed < capture.durationMs ? elapsed : null;
}

/**
 * Starts the ride once the page has its new layout AND every reaction to it (the thread's bottom pin)
 * has run: each captured piece that moved rides from where it stood by ITS OWN move, over the
 * keyboard's duration and curve, started at the keyboard's own start (`startTime = announcedAt`, so
 * each frame draws the keyboard's phase; {@link ridePhaseMs} says where the first is). A piece that did not
 * move, or is gone, does not ride. Null when none moved or the keyboard has landed.
 *
 * Every probe is read before the first `animate`: an animation started dirties style, and a read
 * after it would force the pass for nothing. A thread riding its rows registers the ride with its
 * observer (`attachThreadRide`), so a message arriving mid-ride takes the rows on from where the ride
 * drew them.
 *
 * @param now the clock `announcedAt` was taken on (`performance.now`, whose origin `document.timeline`
 *   shares).
 */
export function startKeyboardRide(
  capture: KeyboardRideCapture,
  now: () => number = () => performance.now()
): KeyboardRide | null {
  const phaseMs = ridePhaseMs(capture, now());
  if (phaseMs === null) {
    Log.d('keyboardRide', 'the keyboard landed before the ride could start - nothing to ride');
    return null;
  }
  const moves: { rider: Rider; distance: number }[] = [];
  for (const rider of capture.riders) {
    const { el, probe, edgeBefore } = rider;
    if (!el.isConnected || !probe.isConnected) continue;
    const distance = rideDistancePx(edgeBefore, rideEdgeOf(probe));
    if (distance !== null) moves.push({ rider, distance });
  }
  const timing: KeyframeAnimationOptions = { duration: capture.durationMs, easing: capture.easing };
  const { announcedAt } = capture;
  const animations: Animation[] = [];
  for (const { rider, distance } of moves) {
    const own = moversOf(rider).map((mover) => {
      const animation = mover.animate(rideKeyframes(distance), timing);
      // On the keyboard's timeline: see the module's comment (D1). The iOS fall starts at 0, pending.
      if (announcedAt !== null) animation.startTime = announcedAt;
      return animation;
    });
    if (rider.rows) attachThreadRide(rider.el, -distance, own);
    animations.push(...own);
  }
  if (animations.length === 0) return null;
  const finished = Promise.allSettled(animations.map((a) => a.finished));
  window.dispatchEvent(new CustomEvent(KEYBOARD_RIDE_EVENT, { detail: { finished } }));
  return { animations, distances: moves.map((m) => m.distance), phaseMs };
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
  // One frame queued at most: a ride that starts while an ended loop's frame is still queued (a
  // stop() or a settle in the same frame) reuses that frame instead of starting a second loop.
  let queued = false;
  const queue = () => {
    if (queued) return;
    queued = true;
    raf(frame);
  };
  const frame = () => {
    queued = false;
    if (!running) return;
    onFrame();
    queue();
  };
  return {
    onRide(finished) {
      const mine = ++latest;
      running = true;
      queue();
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
