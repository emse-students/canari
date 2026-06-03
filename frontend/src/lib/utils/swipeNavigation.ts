import { APP_PLACES } from '$lib/navigation/places';
import { historyOverlayStackDepth } from '$lib/utils/historyOverlayStack';

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

/** True on phone / coarse-pointer layouts where swipe-between-tabs is enabled. */
export function isSwipeNavViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(max-width: 1279px), (pointer: coarse)').matches;
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

/** Whether swipe-between-tabs should be active for the current UI state. */
export function isSwipeNavActive(ctx: SwipeNavContext): boolean {
  if (!isSwipeNavViewport()) return false;
  if (!isSwipeNavRoute(ctx.pathname)) return false;
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
