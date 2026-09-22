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

/**
 * How far from the bottom the reader may be and still count as "at the bottom".
 *
 * NOT A TOLERANCE FOR JITTER - a statement about intent. Between a half-scrolled wheel notch and a
 * reader who has gone looking for something, roughly one message's height is the line: below it
 * they have not left the live end of the conversation, above it they have. It lives here, next to
 * the predicate that reads it, because it was an unexplained `120` inline in a scroll handler and
 * nothing could test it.
 */
export const THREAD_BOTTOM_SLACK_PX = 120;

/** The three numbers `isPinnedToBottom` needs - an `HTMLElement` satisfies it. */
export interface ThreadScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/**
 * **THE ONE BOOLEAN**: is the reader stuck to the bottom of the thread, or have they gone up?
 *
 * The user asked for exactly this, 2026-09-22: *"c'est une histoire de 'coller' le bas de la
 * discussion lorsqu'on n'est pas en train de remonter (j'imagine qu'un True/False pourrait etre
 * coherent ?)"*. Everything the thread does about position is decided by it, and by nothing else:
 * whether a new message scrolls the pane or only raises the unread pill, and whether growth
 * ANYWHERE below - a typing bubble, a taller composer, a reaction chip, the keyboard - is followed.
 *
 * **IT IS MEASURED, NEVER REMEMBERED.** A stored flag would have to be invalidated by every path
 * that moves the pane, which is the bug the `120` inline was one copy of.
 *
 * `scrollHeight` INCLUDES `padding-bottom`, which on this scroller is the composer's measured
 * height (`--chat-composer-height`). That is why growth of the composer and growth of the content
 * are the same quantity here, and why one predicate answers for both.
 */
export function isPinnedToBottom(metrics: ThreadScrollMetrics): boolean {
  return metrics.scrollHeight - (metrics.scrollTop + metrics.clientHeight) < THREAD_BOTTOM_SLACK_PX;
}
