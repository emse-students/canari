/**
 * Touch gesture maths for the media viewer (`MediaLightbox.svelte`), ported from MiGallery's photo
 * viewer, where the thresholds were tuned against Google Photos on the Mi 9T.
 *
 * Everything here is PURE: the component feeds it coordinates and timestamps and applies what comes
 * back, which is what lets the classifier and the snap decisions be pinned by
 * `viewerGestures.test.ts` without a browser. The zoom itself is NOT here: a pinch, a wheel and a
 * double-tap go through `pinchZoom.ts`, the module the PDF reader shares. The reasoning behind every
 * threshold is in `docs/wiki/frontend/modules/posts.md` (the viewer section).
 */

/** A 2D point or offset, in CSS pixels. */
export interface Point {
  x: number;
  y: number;
}

/** A pointer sample: where the finger was, and when (ms, any monotonic clock). */
export interface Sample extends Point {
  t: number;
}

/**
 * What a touch sequence is, once it has said enough:
 * - `pending`: still inside the tap slop, nothing decided yet;
 * - `swipe-h`: horizontal drag on an unzoomed photo (previous / next);
 * - `swipe-down`: downward drag on an unzoomed photo (close);
 * - `swipe-up`: upward drag on an unzoomed photo (opens the information panel);
 * - `pan`: one-finger drag on a zoomed photo;
 * - `pinch`: two fingers or more.
 */
export type GestureKind = 'pending' | 'swipe-h' | 'swipe-down' | 'swipe-up' | 'pan' | 'pinch';

/** Where a released horizontal swipe goes. */
export type SwipeDecision = 'next' | 'previous' | 'stay';

/**
 * Every tunable of the viewer's gestures, in one place.
 * Distances are CSS px, durations ms, velocities px/ms.
 */
export const GESTURE = {
  /** Movement under which a touch is still a tap (Android's touch slop is 8 dp). */
  TAP_SLOP_PX: 10,
  /** A press held longer than this is not a tap. */
  TAP_MAX_MS: 300,
  /**
   * Max gap between two taps for a double-tap, and therefore how long a single tap waits
   * before it is confirmed as single. 250 ms is the usual web figure (Android uses 300).
   */
  DOUBLE_TAP_MS: 250,
  /** Max distance between the two taps of a double-tap. */
  DOUBLE_TAP_SLOP_PX: 50,
  /** Scale a double-tap zooms to. */
  DOUBLE_TAP_SCALE: 2.5,
  /** Above this scale the photo counts as zoomed: one finger pans, swipes are off. */
  ZOOMED_EPSILON: 1.01,
  /** A horizontal swipe released past this fraction of the width commits. */
  SWIPE_COMMIT_RATIO: 0.25,
  /** A swipe released faster than this commits whatever its distance (a flick)... */
  FLICK_VELOCITY: 0.4,
  /** ...provided it travelled at least this far (ViewPager's MIN_DISTANCE_FOR_FLING, 25 dp). */
  FLICK_MIN_DISTANCE_PX: 24,
  /** A downward drag released past this fraction of the height closes the viewer. */
  DISMISS_COMMIT_RATIO: 0.2,
  /** The drag distance, as a fraction of the height, at which the backdrop is fully faded. */
  DISMISS_FADE_RATIO: 0.5,
  /** How much the photo shrinks at full dismiss progress (1 - this). */
  DISMISS_SHRINK: 0.25,
  /** Dragging past the first / last photo moves the image this fraction of the finger. */
  EDGE_RESISTANCE: 0.3,
  /** Only samples this recent are used to measure release velocity. */
  VELOCITY_WINDOW_MS: 100,
  /** Duration of every snap / spring-back animation (0 under prefers-reduced-motion). */
  SETTLE_MS: 220,
} as const;

/** Clamps `value` into `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** True when `scale` is far enough above 1 for the photo to count as zoomed. */
export function isZoomed(scale: number): boolean {
  return scale > GESTURE.ZOOMED_EPSILON;
}

/**
 * Classifies a touch sequence from its displacement since the first finger landed.
 * Stays `pending` inside the tap slop; once out of it, the answer is final for the sequence
 * (the caller locks it), so a swipe that curves does not change nature half-way.
 */
export function classifyMove(input: {
  dx: number;
  dy: number;
  zoomed: boolean;
  touches: number;
}): GestureKind {
  const { dx, dy, zoomed, touches } = input;
  if (touches >= 2) return 'pinch';
  if (Math.hypot(dx, dy) < GESTURE.TAP_SLOP_PX) return 'pending';
  if (zoomed) return 'pan';
  if (Math.abs(dx) > Math.abs(dy)) return 'swipe-h';
  return dy > 0 ? 'swipe-down' : 'swipe-up';
}

/** True when a press from `start` to `end` stayed short and still enough to be a tap. */
export function isTap(start: Sample, end: Sample): boolean {
  return (
    end.t - start.t <= GESTURE.TAP_MAX_MS &&
    Math.hypot(end.x - start.x, end.y - start.y) < GESTURE.TAP_SLOP_PX
  );
}

/** True when `tap` completes a double-tap begun by `previous` (close in time and space). */
export function isDoubleTap(previous: Sample | null, tap: Sample): boolean {
  if (!previous) return false;
  return (
    tap.t - previous.t <= GESTURE.DOUBLE_TAP_MS &&
    Math.hypot(tap.x - previous.x, tap.y - previous.y) <= GESTURE.DOUBLE_TAP_SLOP_PX
  );
}

/**
 * Release velocity from the most recent samples (oldest first). Only the last
 * `VELOCITY_WINDOW_MS` count, so a slow drag ended by a flick reads as the flick.
 */
export function releaseVelocity(samples: readonly Sample[]): Point {
  if (samples.length < 2) return { x: 0, y: 0 };
  const last = samples[samples.length - 1];
  let first = samples[samples.length - 2];
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > GESTURE.VELOCITY_WINDOW_MS) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  if (dt <= 0) return { x: 0, y: 0 };
  return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
}

/**
 * Where the image sits while a horizontal swipe is being dragged: it follows the finger 1:1
 * towards an existing neighbour, and with resistance past the first or last photo.
 */
export function dragOffset(dx: number, hasPrevious: boolean, hasNext: boolean): number {
  const towardsNeighbour = dx < 0 ? hasNext : hasPrevious;
  return towardsNeighbour ? dx : dx * GESTURE.EDGE_RESISTANCE;
}

/**
 * Decides where a released horizontal swipe goes. A swipe LEFT (`dx < 0`) shows the next
 * photo. It commits past `SWIPE_COMMIT_RATIO` of the width, or on a flick in the SAME
 * direction as the drag (a drag flicked back is a change of mind, and stays).
 */
export function decideSwipe(input: {
  dx: number;
  velocityX: number;
  width: number;
  hasPrevious: boolean;
  hasNext: boolean;
}): SwipeDecision {
  const { dx, velocityX, width, hasPrevious, hasNext } = input;
  const decision: SwipeDecision = dx < 0 ? 'next' : 'previous';
  if (dx === 0) return 'stay';
  if (decision === 'next' ? !hasNext : !hasPrevious) return 'stay';
  const far = Math.abs(dx) >= width * GESTURE.SWIPE_COMMIT_RATIO;
  const flick =
    Math.abs(velocityX) >= GESTURE.FLICK_VELOCITY &&
    Math.sign(velocityX) === Math.sign(dx) &&
    Math.abs(dx) >= GESTURE.FLICK_MIN_DISTANCE_PX;
  return far || flick ? decision : 'stay';
}

/**
 * Decides whether a released downward drag closes the viewer: past `DISMISS_COMMIT_RATIO`
 * of the height, or on a downward flick.
 */
export function decideDismiss(input: { dy: number; velocityY: number; height: number }): boolean {
  const { dy, velocityY, height } = input;
  if (dy <= 0) return false;
  if (dy >= height * GESTURE.DISMISS_COMMIT_RATIO) return true;
  return velocityY >= GESTURE.FLICK_VELOCITY && dy >= GESTURE.FLICK_MIN_DISTANCE_PX;
}

/**
 * How far a downward drag has gone towards closing, in `[0, 1]`. Drives both the backdrop
 * fade (`1 - progress`) and the photo's shrink (`dismissScale`).
 */
export function dismissProgress(dy: number, height: number): number {
  if (height <= 0) return 0;
  return clamp(dy / (height * GESTURE.DISMISS_FADE_RATIO), 0, 1);
}

/** The photo's scale at a given dismiss progress. */
export function dismissScale(progress: number): number {
  return 1 - GESTURE.DISMISS_SHRINK * clamp(progress, 0, 1);
}
