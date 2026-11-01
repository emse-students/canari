import { m } from '$lib/paraglide/messages';

/**
 * The sentence under the grid that teaches the drag, in the words of the pointer the reader HAS:
 * a mouse drags at once, a finger must hold first (`SpaceGrid`'s HOLD_MS), so each is told only its
 * own gesture - never a parenthesis naming the other device. `coarse` is
 * `isCoarsePointerDevice()`, the one predicate the app already uses for "a finger, not a mouse".
 *
 * @param blockMode the organiser's dashboard, where the drag blocks free units instead of booking.
 * @param coarse whether the primary pointer is a finger or a stylus.
 */
export function gridDragHint(blockMode: boolean, coarse: boolean): string {
  if (blockMode) {
    return coarse ? m.bookings_grid_block_hint_touch() : m.bookings_grid_block_hint_pointer();
  }
  return coarse ? m.bookings_grid_drag_hint_touch() : m.bookings_grid_drag_hint_pointer();
}
