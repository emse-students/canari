/**
 * WHEN A GROWING THREAD SHOULD FOLLOW ITS OWN BOTTOM.
 *
 * A row can get taller without a message being added - a reaction chip appears, a link preview
 * resolves, an image settles into its real aspect. The pane already re-pinned for a new MESSAGE,
 * keyed on the message COUNT, and a count cannot see any of those: adding a reaction grew the
 * content with nothing watching, so every row below it moved DOWN and the bottom of the thread left
 * the screen. On the last message that put the reaction itself under the composer.
 *
 * The user's words, 2026-09-18: *"mettre une reaction devrait faire monter la discussion, pas la
 * descendre"* - which is the same request read from the other end. Following the bottom is what
 * moves the conversation UP.
 *
 * **THE COUNT WAS THE WRONG PROXY FOR GROWTH, SO THIS ASKS ABOUT GROWTH.** No clock and no delay:
 * the caller reports a height it has just measured, and the only judgement here is whether the
 * reader had asked to be at the bottom.
 */
export interface ThreadGrowth {
  /** `scrollHeight` before the change. */
  previousHeight: number;
  /** `scrollHeight` after it. */
  currentHeight: number;
  /**
   * Whether the reader was at the bottom BEFORE the growth.
   *
   * It must be the earlier value, and it is: nothing recomputes it without a scroll event, and
   * content growing under a stationary reader fires none.
   */
  wasNearBottom: boolean;
  /** Older messages are being prepended - that caller restores the position itself. */
  isLoadingOlder: boolean;
  /** The conversation is still being entered - `fillViewportThenPin` owns the position until it is not. */
  isEntering: boolean;
}

/**
 * Whether the pane should be pinned back to its bottom after a change in content height.
 *
 * Only growth counts. A row SHRINKING (a reaction removed, a preview collapsing) already pulls the
 * bottom up on its own, and pinning there would move a reader who is reading history.
 */
export function shouldFollowThreadBottom(growth: ThreadGrowth): boolean {
  if (growth.currentHeight <= growth.previousHeight) return false;
  // PREPENDING IS GROWTH THAT MEANS THE OPPOSITE. `loadOlderGroups` adds height ABOVE the reader and
  // restores `scrollTop` by exactly that much; following the bottom here would throw away the
  // history it had just fetched and land them where they already were.
  if (growth.isLoadingOlder) return false;
  if (growth.isEntering) return false;
  return growth.wasNearBottom;
}
