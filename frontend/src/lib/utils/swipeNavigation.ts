import { APP_PLACES } from '$lib/navigation/places';
import { historyOverlayStackDepth } from '$lib/utils/historyOverlayStack';
import { isSwipeNavViewport as isSwipeViewportQuery } from './viewport';

/** Routes where horizontal tab swipe must not change the main app section. */
const SWIPE_NAV_EXCLUDED_PREFIXES = [
  '/associations',
  '/profile',
  '/forms',
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

const SWIPE_THRESHOLD_PX = 60;
const HORIZONTAL_DOMINANCE_RATIO = 1.5;
const GESTURE_LOCK_PX = 12;

export type SwipeNavDirection = 'prev' | 'next';

export type SwipeNavGestureState = {
  startX: number;
  startY: number;
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
 * Returns true when the touch target lies inside a horizontally scrollable region
 * or an element marked with `data-swipe-nav-ignore`.
 */
export function shouldIgnoreSwipeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;

  let node: Element | null = target;
  while (node && node !== document.documentElement) {
    if (node instanceof HTMLElement) {
      if (node.dataset.swipeNavIgnore !== undefined) return true;
      if (node.dataset.swipeReply !== undefined) return true;
      const tag = node.tagName;
      if (tag === 'A' && node.hasAttribute('href')) return true;
      if (tag === 'BUTTON') return true;
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

export function classifySwipeRelease(
  dx: number,
  dy: number,
  phase: SwipeNavGestureState['phase']
): SwipeNavDirection | null {
  if (phase !== 'horizontal') return null;
  if (
    Math.abs(dx) < SWIPE_THRESHOLD_PX ||
    Math.abs(dx) < Math.abs(dy) * HORIZONTAL_DOMINANCE_RATIO
  ) {
    return null;
  }
  return dx < 0 ? 'next' : 'prev';
}

export function createSwipeNavGestureState(clientX: number, clientY: number): SwipeNavGestureState {
  return { startX: clientX, startY: clientY, phase: 'pending', dragPx: 0 };
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

export const swipeNavTransitionMs = 220;
