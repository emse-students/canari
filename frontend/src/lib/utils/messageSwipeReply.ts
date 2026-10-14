/** Horizontal drag (px) before locking a reply swipe vs vertical scroll. */
export const REPLY_SWIPE_LOCK_PX = 10;

/** Minimum horizontal travel toward the thread center to trigger reply. */
export const REPLY_SWIPE_TRIGGER_PX = 56;

/** Max visual drag distance for the bubble. */
export const REPLY_SWIPE_MAX_DRAG_PX = 72;

export type ReplySwipePhase = 'pending' | 'vertical' | 'horizontal' | 'ignored';

export type ReplySwipeGestureState = {
  startX: number;
  startY: number;
  phase: ReplySwipePhase;
};

export function createReplySwipeGesture(clientX: number, clientY: number): ReplySwipeGestureState {
  return { startX: clientX, startY: clientY, phase: 'pending' };
}

export function updateReplySwipeGesture(
  state: ReplySwipeGestureState,
  clientX: number,
  clientY: number
): ReplySwipeGestureState {
  const dx = clientX - state.startX;
  const dy = clientY - state.startY;

  if (state.phase === 'pending') {
    if (Math.abs(dx) < REPLY_SWIPE_LOCK_PX && Math.abs(dy) < REPLY_SWIPE_LOCK_PX) {
      return state;
    }
    if (Math.abs(dy) > Math.abs(dx)) {
      return { ...state, phase: 'vertical' };
    }
    return { ...state, phase: 'horizontal' };
  }

  return state;
}

/**
 * Returns the clamped horizontal offset for the bubble while dragging, or null if the
 * direction does not match a reply swipe for this message side.
 */
export function replySwipeDragOffset(
  deltaX: number,
  isOwn: boolean,
  maxDrag = REPLY_SWIPE_MAX_DRAG_PX
): number | null {
  if (isOwn) {
    if (deltaX > 6) return null;
    return Math.max(-maxDrag, Math.min(0, deltaX));
  }
  if (deltaX < -6) return null;
  return Math.min(maxDrag, Math.max(0, deltaX));
}

/**
 * True when releasing NOW sends the reply: the gesture locked horizontal and the bubble is drawn
 * armed. It is the same `replySwipeArmed(replySwipeDragOffset(...))` the bubble paints from, so what
 * the reader sees before letting go is, by construction, what letting go does.
 *
 * **IT USED TO ASK A SECOND QUESTION THE BUBBLE NEVER SHOWED** (Mi 9T, 2026-10-14): a vertical drift
 * of `0.75 * REPLY_SWIPE_TRIGGER_PX` (42px) at release cancelled the reply. The drag ignores the
 * vertical axis once locked, so a thumb's natural arc - 110px across, 45px down - slid the bubble
 * fully, lit the armed icon, ticked the haptic, and then did nothing. That was the "sometimes" of
 * the report. The vertical question is answered ONCE, at the lock (`updateReplySwipeGesture`), and a
 * locked horizontal gesture does not scroll the thread, so nothing is left for it to protect.
 */
export function shouldTriggerReplySwipe(
  deltaX: number,
  isOwn: boolean,
  phase: ReplySwipePhase
): boolean {
  if (phase !== 'horizontal') return false;
  return replySwipeArmed(replySwipeDragOffset(deltaX, isOwn) ?? 0);
}

/** Progress 0-1 for reply hint opacity (based on drag toward trigger). */
export function replySwipeProgress(dragPx: number, _isOwn: boolean): number {
  const magnitude = Math.abs(dragPx);
  return Math.min(1, magnitude / REPLY_SWIPE_TRIGGER_PX);
}

/**
 * True once the drag has travelled far enough that letting go sends the reply. The bubble shows it
 * (a solid, larger icon and one haptic tick) so the reader knows BEFORE releasing, instead of
 * guessing where the threshold is (Mi 9T, 2026-10-05: the hint stayed a dull half-opaque disc).
 */
export function replySwipeArmed(dragPx: number): boolean {
  return Math.abs(dragPx) >= REPLY_SWIPE_TRIGGER_PX;
}

/**
 * THERE WAS A REACTION SWIPE HERE, AND IT IS GONE ON PURPOSE (user, 2026-09-22).
 *
 * Dragging a bubble AWAY from the centre opened the reaction tray. *"swiper pour reagir n'est pas
 * quelque chose de bien, c'est meme assez bizarre. Tu peux retirer ceci."* It was measured against
 * Messenger 579.0.0.61.91 on the same handset before it was cut: an outward drag there produces no
 * displacement at all, on either side of the thread, and no reaction. Reacting is the long press
 * and the double tap, both of which stay.
 *
 * So an outward drag is now a NON-GESTURE - `replySwipeDragOffset` returns `null` for it, the
 * bubble does not move, and nothing is armed. That is asserted in the tests rather than left to
 * this comment, because a deleted gesture is exactly the kind of thing a later refactor restores.
 */

/** What a bubble knows about itself when it is asked whether a swipe may start. */
export interface ReplySwipeEligibility {
  /** The reader's PRIMARY pointer is a finger or a stylus (`isCoarsePointerDevice`). */
  coarsePointer: boolean;
  /** The pointer that produced this event, when the event carries one. */
  pointerType?: string;
  /** A tombstone has nothing to reply to. */
  isDeleted: boolean;
  /** A system notice is not somebody's message. */
  isSystem: boolean;
  /** Whether a surface actually wired a reply handler. */
  hasReplyHandler: boolean;
}

/**
 * MAY A SWIPE START ON THIS BUBBLE?
 *
 * **THIS PREDICATE LIVED IN THE COMPONENT AND WAS WRONG THERE FOR SIX MONTHS.** It read a
 * `supportsHover` flag initialised to `true` and assigned by nothing, so it answered "no" on every
 * device, and the whole gesture - reply AND the reaction swipe that shares its handler - has never
 * once run in production. Everything in this file was tested and correct; nothing called it.
 * *"la reponse en swipant un message n'a pas l'air de marcher, est-elle implementee ?"* (user,
 * 2026-09-20 - it was, and it was switched off).
 *
 * It is here, and not in the bubble, because that is what makes it testable: a gate a component
 * holds privately is a gate no test can fail. The capability question it asks is
 * `isCoarsePointerDevice()`, which this repo already owns - a mouse-and-keyboard reader has the
 * hover toolbar and does not need a gesture, and a laptop with a touchscreen reports `fine` and
 * keeps the toolbar.
 */
export function canStartReplySwipe(state: ReplySwipeEligibility): boolean {
  if (!state.coarsePointer || state.pointerType === 'mouse') return false;
  return !state.isDeleted && !state.isSystem && state.hasReplyHandler;
}
