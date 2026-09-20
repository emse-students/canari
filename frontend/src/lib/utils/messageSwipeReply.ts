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

/** True when the user released a valid reply swipe (toward the center of the thread). */
export function shouldTriggerReplySwipe(
  deltaX: number,
  deltaY: number,
  isOwn: boolean,
  phase: ReplySwipePhase,
  threshold = REPLY_SWIPE_TRIGGER_PX
): boolean {
  if (phase !== 'horizontal') return false;
  const towardCenter = isOwn ? deltaX < -threshold : deltaX > threshold;
  return towardCenter && Math.abs(deltaY) < threshold * 0.75;
}

/** Progress 0-1 for reply hint opacity (based on drag toward trigger). */
export function replySwipeProgress(dragPx: number, _isOwn: boolean): number {
  const magnitude = Math.abs(dragPx);
  return Math.min(1, magnitude / REPLY_SWIPE_TRIGGER_PX);
}

/**
 * Like replySwipeDragOffset but for the reaction direction (opposite of reply).
 * Own messages drag rightward; others' messages drag leftward.
 */
export function reactionSwipeDragOffset(
  deltaX: number,
  isOwn: boolean,
  maxDrag = REPLY_SWIPE_MAX_DRAG_PX
): number | null {
  if (isOwn) {
    if (deltaX < -6) return null; // left = reply direction for own
    return Math.min(maxDrag, Math.max(0, deltaX));
  }
  if (deltaX > 6) return null; // right = reply direction for others
  return Math.max(-maxDrag, Math.min(0, deltaX));
}

/** True when the user released a valid reaction swipe (away from thread center). */
export function shouldTriggerReactionSwipe(
  deltaX: number,
  deltaY: number,
  isOwn: boolean,
  phase: ReplySwipePhase,
  threshold = REPLY_SWIPE_TRIGGER_PX
): boolean {
  if (phase !== 'horizontal') return false;
  const awayFromCenter = isOwn ? deltaX > threshold : deltaX < -threshold;
  return awayFromCenter && Math.abs(deltaY) < threshold * 0.75;
}

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
