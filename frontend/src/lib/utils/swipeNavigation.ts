import { APP_PLACES } from '$lib/navigation/places';
import { historyOverlayStackDepth } from '$lib/utils/historyOverlayStack';
import { isSwipeNavViewport as isSwipeViewportQuery } from './viewport';

/** Routes where horizontal tab swipe must not change the main app section. */
const SWIPE_NAV_EXCLUDED_PREFIXES = [
  '/associations',
  '/profile',
  '/forms',
  '/f',
  '/events',
  '/admin',
  '/auth',
  '/dev',
  '/account',
  '/legal',
  '/login',
] as const;

/** Bottom-nav places that can be switched with a horizontal swipe. */
export const MOBILE_SWIPE_PLACES = APP_PLACES.filter((p) => p.mobileNav);

/**
 * A FIXED 60px WAS A TAP'S WORTH OF DRIFT AND IT CHANGED THE PAGE (user, 2026-09-29: *"le swipe est
 * un peu trop sensible, parfois un clic un peu baveux change de page"*).
 *
 * The number was the whole rule: travel 60px horizontally, in any manner, over any duration, and
 * the tab changed. A thumb pressing a card and rolling as it lifts covers that on a phone - it is
 * 15% of a 390px screen - so the gesture fired on touches nobody meant as a gesture, and the only
 * way to stop it was to hold perfectly still.
 *
 * So the release now asks the question a pager asks: was this carried FAR, or was it THROWN?
 * A quarter of the screen commits at any speed, a flick commits at any length above the floor, and
 * a tap is neither - it drifts a little, slowly, and is refused. The floor exists because a
 * velocity alone would let a 20px twitch through on the strength of being brief.
 */
const SWIPE_MIN_TRAVEL_PX = 56;
const SWIPE_TRAVEL_FRACTION = 0.25;
const SWIPE_FLICK_PX_PER_MS = 0.5;
const HORIZONTAL_DOMINANCE_RATIO = 1.5;
const GESTURE_LOCK_PX = 12;

export type SwipeNavDirection = 'prev' | 'next';

export type SwipeNavGestureState = {
  startX: number;
  startY: number;
  /** `performance.now()` at touch start - the release reads it to tell a flick from a drift. */
  startedAt: number;
  phase: 'pending' | 'vertical' | 'horizontal' | 'ignored';
  dragPx: number;
};

/**
 * True on phone / coarse-pointer layouts where swipe-between-tabs is enabled.
 *
 * Width OR pointer, and the pointer half is the point: swiping between tabs needs a finger, so a
 * touch laptop gets it at any width while a narrow mouse window does not. `viewport.ts` keeps that
 * distinct from the overlay question for exactly this reason.
 */
export function isSwipeNavViewport(): boolean {
  return isSwipeViewportQuery();
}

/** True when the pathname is a main mobile tab (not association edit, profile, etc.). */
export function isSwipeNavRoute(pathname: string): boolean {
  if (SWIPE_NAV_EXCLUDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return false;
  }
  return MOBILE_SWIPE_PLACES.some(
    (place) => pathname === place.href || pathname.startsWith(`${place.href}/`)
  );
}

/**
 * Returns true when the touch target lies inside a horizontally scrollable region, a text input,
 * or an element (or ancestor) marked with `data-swipe-nav-ignore` - which is how a header opts
 * itself out (`Navbar.svelte`, `MobileHeader.svelte`) rather than this function naming element
 * TYPES that happen to live there.
 *
 * A PLAIN LINK OR BUTTON IS NOT EXCLUDED (2026-09-22, user: *"the swipe should occur when
 * starting something else than empty space"*). It used to be, which meant almost nothing in a
 * feed of post/form/association cards - each one an `<a>` - could start the gesture, and "empty
 * space" was the one region small enough that a reader had to hunt for it. `classifySwipeRelease`
 * already tells a stationary tap from a real horizontal drag by DISPLACEMENT (`GESTURE_LOCK_PX`,
 * the travel and flick rules, the dominance ratio), independent of what element the touch started on -
 * a tap that never moves enough never reaches `preventDefault`, so a card's own click still fires
 * exactly as before. Only regions with their OWN horizontal meaning stay excluded: a text field
 * (dragging to select text), a horizontally-scrollable strip (dragging to scroll it), and anything
 * carrying its own competing gesture (`data-swipe-reply` message bubbles).
 */
export function shouldIgnoreSwipeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;

  let node: Element | null = target;
  while (node && node !== document.documentElement) {
    if (node instanceof HTMLElement) {
      if (node.dataset.swipeNavIgnore !== undefined) return true;
      if (node.dataset.swipeReply !== undefined) return true;
      const tag = node.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable) {
        return true;
      }
      const { overflowX } = getComputedStyle(node);
      if (
        (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay') &&
        node.scrollWidth > node.clientWidth + 2
      ) {
        return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

export function resolveSwipeNavIndex(pathname: string): number {
  const place = MOBILE_SWIPE_PLACES.find(
    (p) => pathname === p.href || pathname.startsWith(`${p.href}/`)
  );
  if (!place) return -1;
  return MOBILE_SWIPE_PLACES.findIndex((p) => p.id === place.id);
}

export function swipeNavTargetHref(pathname: string, direction: SwipeNavDirection): string | null {
  const index = resolveSwipeNavIndex(pathname);
  if (index === -1) return null;
  const nextIndex = direction === 'next' ? index + 1 : index - 1;
  if (nextIndex < 0 || nextIndex >= MOBILE_SWIPE_PLACES.length) return null;
  return MOBILE_SWIPE_PLACES[nextIndex].href;
}

/**
 * How far a deliberate drag must travel to commit: a quarter of the screen, never less than the
 * floor. Proportional because 60px is a third of a thumb on a phone and a rounding error on a
 * tablet, and one constant cannot mean "a deliberate stroke" on both.
 */
export function swipeCommitTravelPx(): number {
  const width = typeof window !== 'undefined' ? window.innerWidth : 0;
  if (width <= 0) return SWIPE_MIN_TRAVEL_PX * 1.5;
  return Math.max(SWIPE_MIN_TRAVEL_PX, width * SWIPE_TRAVEL_FRACTION);
}

export function classifySwipeRelease(
  dx: number,
  dy: number,
  phase: SwipeNavGestureState['phase'],
  elapsedMs: number
): SwipeNavDirection | null {
  if (phase !== 'horizontal') return null;

  const travel = Math.abs(dx);
  if (travel < SWIPE_MIN_TRAVEL_PX) return null;
  if (travel < Math.abs(dy) * HORIZONTAL_DOMINANCE_RATIO) return null;

  const flicked = elapsedMs > 0 && travel / elapsedMs >= SWIPE_FLICK_PX_PER_MS;
  if (!flicked && travel < swipeCommitTravelPx()) return null;

  return dx < 0 ? 'next' : 'prev';
}

export function createSwipeNavGestureState(
  clientX: number,
  clientY: number,
  startedAt: number
): SwipeNavGestureState {
  return { startX: clientX, startY: clientY, startedAt, phase: 'pending', dragPx: 0 };
}

export function updateSwipeNavGesture(
  state: SwipeNavGestureState,
  clientX: number,
  clientY: number
): SwipeNavGestureState {
  const dx = clientX - state.startX;
  const dy = clientY - state.startY;

  if (state.phase === 'pending') {
    if (Math.abs(dx) < GESTURE_LOCK_PX && Math.abs(dy) < GESTURE_LOCK_PX) {
      return { ...state, dragPx: dx };
    }
    if (Math.abs(dy) > Math.abs(dx) * 1.15) {
      return { ...state, phase: 'vertical', dragPx: 0 };
    }
    return { ...state, phase: 'horizontal', dragPx: dx };
  }

  if (state.phase === 'horizontal') {
    return { ...state, dragPx: dx };
  }

  return state;
}

export type SwipeNavContext = {
  pathname: string;
  mobileConvoOpen: boolean;
  keyboardOpen: boolean;
};

/**
 * Whether this SCREEN can ever swipe - the coarse half of the question, and the ONLY half that may
 * decide whether a touch LISTENER EXISTS.
 *
 * THE TWO HALVES ARE NOT THE SAME QUESTION, AND CONFLATING THEM COST EVERY SCROLL IN THE APP.
 * `isSwipeNavActive` below answers "may THIS gesture navigate", which depends on things that change
 * under the finger - a keyboard, an open conversation, an overlay on the history stack. That answer
 * is read inside the handlers, at gesture time, and it is right to read it late.
 *
 * But a NON-PASSIVE `touchmove` listener costs its scroller whether or not its handler ever does
 * anything: the engine cannot know the handler will return immediately, so it marks the region
 * non-fast-scrollable and hands every move to the main thread BEFORE it is allowed to scroll. The
 * root layout bound one unconditionally - on every route and every platform, `/associations` and
 * the nine other swipe-EXCLUDED prefixes included - so every scroll in the app paid for a gesture
 * most screens cannot perform. Reported from an iPhone 2026-09-20 as unpainted bands during a
 * scroll of the feed, which is what a compositor shows when rasterisation is waiting on a blocked
 * main thread.
 *
 * So arming asks only what a screen IS - its route and its viewport - and never what the moment is.
 * Both of those change through a re-render the listener set can follow; none of the others can.
 *
 * `swipeViewport` is passed in rather than read here because the caller that matters holds it as
 * reactive state (a `matchMedia` read answers once and never again, and the listener set has to
 * follow a rotation). One implementation, two callers.
 */
export function isSwipeNavArmed(pathname: string, swipeViewport: boolean): boolean {
  return swipeViewport && isSwipeNavRoute(pathname);
}

/** Whether swipe-between-tabs should be active for the current UI state. */
export function isSwipeNavActive(ctx: SwipeNavContext): boolean {
  if (!isSwipeNavArmed(ctx.pathname, isSwipeNavViewport())) return false;
  if (ctx.mobileConvoOpen || ctx.keyboardOpen) return false;
  if (historyOverlayStackDepth() > 0) return false;
  return true;
}

export function swipeDragResistancePx(
  dragPx: number,
  direction: SwipeNavDirection | null,
  canGoNext: boolean,
  canGoPrev: boolean
): number {
  const max = typeof window !== 'undefined' ? window.innerWidth * 0.42 : 160;
  let clamped = Math.max(-max, Math.min(max, dragPx));
  if (clamped < 0 && !canGoNext) clamped *= 0.28;
  if (clamped > 0 && !canGoPrev) clamped *= 0.28;
  return clamped;
}

/**
 * How far the finger had already carried the outgoing page when it let go, as a MAGNITUDE.
 *
 * The release animation hands this to CSS as `--swipe-nav-from`, and the four keyframes it feeds
 * spell their own direction (`calc(-100% + var(...))` for a page leaving left, `calc(100% -
 * var(...))` for the one arriving behind it). So the sign is the DIRECTION's to carry, not this
 * number's: passing it signed would mean every keyframe worked for one direction and silently
 * inverted for the other, which is the kind of mirror-image defect a phone shows and a test does
 * not. Clamped to a viewport so a bad `dragPx` cannot place a page beyond the screen it slides in
 * from.
 */
export function swipeNavSlideOriginPx(offsetPx: number): number {
  const width = typeof window !== 'undefined' ? window.innerWidth : 0;
  const magnitude = Math.abs(offsetPx);
  return width > 0 ? Math.min(magnitude, width) : magnitude;
}

export const swipeNavTransitionMs = 220;
/**
 * How far a computed `transform` moves its element sideways, as a magnitude in px.
 *
 * `getComputedStyle().transform` reports the value MID-TRANSITION - `matrix(a, b, c, d, tx, ty)` or
 * `matrix3d(...)` with `tx` at index 12 - which is what the swipe needs: the released page keeps
 * moving (`+layout.svelte`, `commitSwipeNav`), and the view transition must start from wherever it
 * has got to, or the strip jumps back to the release point. `none` is no movement.
 */
export function transformTranslateXPx(transform: string): number {
  const m = /^matrix(3d)?\(([^)]*)\)$/.exec(transform.trim());
  if (!m) return 0;
  const values = m[2].split(',').map((v) => Number.parseFloat(v));
  const tx = values[m[1] ? 12 : 4];
  return Number.isFinite(tx) ? Math.abs(tx) : 0;
}
