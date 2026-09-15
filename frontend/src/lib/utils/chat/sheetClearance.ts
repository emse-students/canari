/**
 * LIFTING THE MESSAGE CLEAR OF THE SHEET THAT ACTS ON IT.
 *
 * The long-press action sheet is anchored to the BOTTOM of the screen, which is where a thumb is
 * and where it must stay. The thread behind it does not move, so any message in the bottom band is
 * hidden by the sheet acting on it. Measured on A1 on 2026-09-14: the bubble at `731-767`, the
 * sheet's reaction strip starting at `749` - 18 of the bubble's 37 px covered, its lower half,
 * through the middle of its single line of text. The user long-presses a message and can no longer
 * read the message they long-pressed.
 *
 * **THE SHEET IS NOT MOVED. THE THREAD IS.** WhatsApp and Messenger both raise the message above
 * the sheet and dim the rest, and that is the right half to move: the sheet's position is a claim
 * about where a hand is, and the thread's is a claim about nothing.
 *
 * **AND THE ROOM HAS TO EXIST BEFORE ANYTHING CAN SCROLL INTO IT.** The message pressed at the
 * bottom of the screen is usually the LAST one, which means the scroller is already at its maximum
 * and `scrollTop += n` does nothing at all - the obvious fix is a no-op in exactly the case that
 * motivated it. So the deficit is borrowed as bottom padding on the scroller for as long as the
 * sheet is open, and returned when it closes; removing it puts the thread back where it was,
 * without anything having to remember a scroll position.
 *
 * Everything here is arithmetic on numbers a caller measured. No clock, no animation frame, no
 * retry: the sheet's resting geometry is known the moment it is in the tree, and a decision that
 * can be taken from four numbers should not be taken from a timer.
 */

/** Pixels left between the bubble's bottom edge and the sheet's top edge once the lift is done. */
export const SHEET_CLEARANCE_GAP_PX = 8;

/** Everything the lift is decided from, all in viewport coordinates and all measurable at open. */
export interface SheetClearanceInput {
  /** Top edge of the bubble the sheet acts on. */
  bubbleTop: number;
  /** Bottom edge of that bubble. */
  bubbleBottom: number;
  /** Top edge of the sheet at REST - not mid-transition; see `sheetRestingTop`. */
  sheetTop: number;
  /** Top edge of the scroller's own box, which is what clips the thread. */
  scrollerTop: number;
  /** How much further `scrollTop` can still be increased: `scrollHeight - scrollTop - clientHeight`. */
  scrollRemaining: number;
  /** Clearance to leave below the bubble (default {@link SHEET_CLEARANCE_GAP_PX}). */
  gap?: number;
}

/** What the caller must do to the scroller, in the order the fields are listed. */
export interface SheetClearance {
  /** Bottom padding to ADD to the scroller so the scroll below has somewhere to go. */
  padBy: number;
  /** Pixels to add to the scroller's `scrollTop`, after the padding is in place. */
  scrollBy: number;
}

/** Nothing to do - the sheet already clears the bubble. */
const NO_LIFT: SheetClearance = { padBy: 0, scrollBy: 0 };

/**
 * Where the sheet's top edge WILL be, computed from layout rather than from its current rect.
 *
 * The sheet flies in over 220 ms, so for most of the first frames after it opens its
 * `getBoundingClientRect().top` is wherever the transform has it, not where it comes to rest -
 * and a lift measured from that is short by the transform's remaining offset. Waiting for the
 * transition to end would make this depend on a clock, which is the thing being removed.
 *
 * Neither input is affected by a transform: `offsetHeight` is layout, and the computed `bottom` of
 * a positioned element is an absolute length. The sheet's containing block is the full-screen
 * overlay, so its bottom edge is the third term.
 *
 * @param overlayBottom - bottom edge of the sheet's containing block (the `inset-0` overlay).
 * @param bottomInset - the sheet's computed `bottom`, in pixels.
 * @param sheetHeight - the sheet's laid-out height, in pixels.
 */
export function sheetRestingTop(
  overlayBottom: number,
  bottomInset: number,
  sheetHeight: number
): number {
  return overlayBottom - bottomInset - sheetHeight;
}

/**
 * How far the thread must move, and how much room must be made first.
 *
 * **THE LIFT IS CAPPED BY THE BUBBLE'S OWN HEAD.** A message taller than the room above the sheet
 * cannot be shown whole whatever anyone scrolls, and lifting it until its bottom clears would push
 * its FIRST line off the top of the scroller - trading the half a reader can do without for the
 * half they are reading. So the lift stops when the bubble's top reaches the scroller's, and what
 * remains covered is the tail of a message whose beginning is on screen.
 *
 * Results are whole pixels, rounded UP: a sub-pixel shortfall is a visible sliver of bubble under
 * the sheet, and a sub-pixel surplus is nothing at all.
 */
export function sheetClearance({
  bubbleTop,
  bubbleBottom,
  sheetTop,
  scrollerTop,
  scrollRemaining,
  gap = SHEET_CLEARANCE_GAP_PX,
}: SheetClearanceInput): SheetClearance {
  const overlap = bubbleBottom + gap - sheetTop;
  if (overlap <= 0) return NO_LIFT;

  const headroom = Math.max(0, bubbleTop - scrollerTop);
  const scrollBy = Math.ceil(Math.min(overlap, headroom));
  if (scrollBy <= 0) return NO_LIFT;

  return { padBy: Math.max(0, Math.ceil(scrollBy - scrollRemaining)), scrollBy };
}
