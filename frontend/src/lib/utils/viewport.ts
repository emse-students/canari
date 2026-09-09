import { COARSE_POINTER_QUERY } from './pointerDevice';

/**
 * THE ONE PLACE THIS APP DECIDES WHAT "A NARROW SCREEN" MEANS.
 *
 * FOUR DIFFERENT ANSWERS WERE IN THE TREE, and no two of them agreed:
 *
 *   `(max-width: 768px), (pointer: coarse)`    ChatArea, ChatComposer
 *   `(max-width: 767px)`                       TabFollowerBanner
 *   `(max-width: 1279px)`                      historyOverlayStack
 *   `(max-width: 1279px), (pointer: coarse)`   swipeNavigation
 *
 * Two of those divergences were bugs and two were not, which is exactly why one predicate would
 * have been the wrong repair:
 *
 *   - THE 768 IS OFF BY ONE AGAINST THE MARKUP. Tailwind's `md:` starts AT 768px, so a viewport
 *     exactly 768px wide gets the two-pane layout from the CSS while `max-width: 768px` told the
 *     script it was on a phone. `md - 0.02` is the boundary Tailwind itself computes, so the class
 *     and the query can no longer disagree at their shared edge.
 *   - 767 VS 768 WAS THE SAME BUG, spelt as a workaround for it.
 *   - THE TWO 1279s ARE A REAL DISTINCTION AND ARE KEPT AS TWO. Overlays are about how much room
 *     there is, so they ask about width alone; swiping between tabs is about having a finger, so it
 *     asks about width OR pointer. Collapsing them would have given a touch laptop swipe gestures
 *     it has no way to mean, or taken full-screen drawers away from a narrow mouse window that
 *     needs them.
 *
 * So this module names the QUESTIONS rather than exporting one boolean, and every breakpoint is
 * derived from Tailwind's own scale instead of retyped. Nothing here reads `app.css`: that file
 * overrides no `--breakpoint-*`, so the framework defaults are the truth and are asserted in
 * `viewport.test.ts` - if a future `@theme` block moves `md`, that test fails rather than the
 * layout quietly splitting in two again.
 */
const TAILWIND_MD = 768;
const TAILWIND_XL = 1280;

/**
 * The largest width still BELOW a Tailwind breakpoint.
 *
 * Tailwind emits `min-width` queries, so the complement of `md:` is everything under 768px - not
 * everything up to and including it. The 0.02px step is what Tailwind uses itself, and it is small
 * enough that no real device lands inside it.
 */
const below = (px: number) => `(max-width: ${px - 0.02}px)`;

/** Chat is a SINGLE PANE here: the conversation list and a conversation cannot both be on screen. */
export const NARROW_CHAT_QUERY = `${below(TAILWIND_MD)}, ${COARSE_POINTER_QUERY}`;

/** Chat and drawers are full-screen overlays here rather than panels (matches Tailwind `xl`). */
export const OVERLAY_LAYOUT_QUERY = below(TAILWIND_XL);

/** Swipe-between-tabs applies here: narrow, or driven by a finger. */
export const SWIPE_NAV_QUERY = `${below(TAILWIND_XL)}, ${COARSE_POINTER_QUERY}`;

/**
 * The agenda draws a schedule LIST rather than a month grid here (matches Tailwind `md`).
 *
 * WIDTH ALONE, AND THAT IS THE DISTINCTION FROM `NARROW_CHAT_QUERY`. Seven columns is a question
 * about ROOM: a touch laptop has it and should keep the grid, which shows the shape of a month at a
 * glance. Chat asks the other question - whether a list and a conversation fit side by side - and a
 * finger changes that answer, which is why it also asks about the pointer.
 */
export const SCHEDULE_AGENDA_QUERY = below(TAILWIND_MD);

/** Whether `matchMedia` can be asked at all - it cannot under SSR, nor in a bare test environment. */
function canQuery(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

/**
 * Answers a viewport question, and answers `false` when it cannot know.
 *
 * `false` is the desktop answer, and that is deliberate: a server render must not commit to the
 * cramped layout for a machine that may have room, and the mount that follows corrects it on the
 * same frame. The mirror of `isCoarsePointerDevice`, for the same reason.
 */
function matches(query: string): boolean {
  if (!canQuery()) return false;
  return window.matchMedia(query).matches;
}

/** True when the conversation list and a conversation cannot be seen at the same time. */
export function isNarrowChatLayout(): boolean {
  return matches(NARROW_CHAT_QUERY);
}

/** True where chat and drawers take the whole screen instead of sitting in a panel. */
export function isOverlayLayout(): boolean {
  return matches(OVERLAY_LAYOUT_QUERY);
}

/** True where swiping between the main tabs is enabled. */
export function isSwipeNavViewport(): boolean {
  return matches(SWIPE_NAV_QUERY);
}

/** True where a month grid has no room and the agenda is a schedule list instead. */
export function isScheduleAgendaViewport(): boolean {
  return matches(SCHEDULE_AGENDA_QUERY);
}

/**
 * Calls `listener` whenever the answer to `query` changes - a rotation, a resized window, a browser
 * toggling device emulation. Returns a teardown; a no-op one where nothing can be observed.
 */
export function onViewportChange(query: string, listener: (narrow: boolean) => void): () => void {
  if (!canQuery()) return () => {};
  const mq = window.matchMedia(query);
  const handler = (event: MediaQueryListEvent) => listener(event.matches);
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
