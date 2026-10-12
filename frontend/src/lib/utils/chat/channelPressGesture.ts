/**
 * Tells a STILL PRESS on a reorderable salon row apart from a drag, from the drag's own events.
 *
 * A TAP HELD PAST THE ZONE'S HOLD DELAY USED TO DO NOTHING (user, iPhone, 2026-10-12: *"parfois je
 * clique sur le salon mais rien ne se passe"*). The salon list is a `svelte-dnd-action` zone with
 * `delayTouchStart: 350` for whoever may reorder it, and once the hold elapses the library starts a
 * drag WITHOUT any movement: it lifts the row out of the list, and the release drops it back in
 * place. The browser's own `click` never reaches the row - the element under the finger was moved
 * away - so a resting finger opened nothing. Measured on the iPhone 12 bench: holds of 60, 150 and
 * 300 ms opened the salon, 400, 600 and 900 ms never did, every time.
 *
 * THE DISCRIMINATOR IS WHERE THE PLACEHOLDER WENT, never how long the finger stayed down. The
 * library puts a shadow item where the row would land and reports it in every `consider`: it starts
 * at the row's own index, and a finger that moves over a neighbour, or out of the list, moves it or
 * removes it. A drag whose shadow never left its starting index was a press, and a press is a tap.
 * A drag that went away and came back is NOT one: its shadow left, and that is recorded.
 */

import { SHADOW_ITEM_MARKER_PROPERTY_NAME, TRIGGERS } from 'svelte-dnd-action';

/** The index of the drag's placeholder in `items`, or -1 when it is in no slot of this list. */
function shadowIndex(items: readonly object[]): number {
  return items.findIndex(
    (item) => (item as Record<string, unknown>)[SHADOW_ITEM_MARKER_PROPERTY_NAME] === true
  );
}

/** What one drag on the list was, read at its `finalize`. */
export type ChannelPressOutcome =
  /** The row was pressed and released where it was: the caller owes it the tap it swallowed. */
  | { kind: 'tap'; id: string }
  /** The row was moved, or the drag was not seen from its start: the caller persists the order. */
  | { kind: 'reorder' };

/**
 * One tracker per zone. `consider` and `finalize` are fed the library's events verbatim; nothing
 * here reads a clock, so the verdict is the same however long the hold lasted.
 */
export function createChannelPressTracker() {
  /** The placeholder's index when the drag started; -1 while no drag is tracked. */
  let origin = -1;
  let moved = false;

  return {
    /** Feed every `consider` of the zone. */
    consider(items: readonly object[], trigger: string): void {
      const at = shadowIndex(items);
      if (trigger === TRIGGERS.DRAG_STARTED) {
        origin = at;
        moved = false;
        return;
      }
      if (origin !== -1 && at !== origin) moved = true;
    },

    /**
     * Feed the zone's `finalize`; returns what the gesture was and forgets it.
     * @param id the dragged row's id, `e.detail.info.id`.
     */
    finalize(id: string): ChannelPressOutcome {
      const wasPress = origin !== -1 && !moved;
      origin = -1;
      moved = false;
      return wasPress ? { kind: 'tap', id } : { kind: 'reorder' };
    },
  };
}
