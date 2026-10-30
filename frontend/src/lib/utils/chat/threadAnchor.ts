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
  /** How far the pane could scroll before the change - {@link threadReach}, not `scrollHeight`. */
  previousReach: number;
  /** The same quantity after the change. */
  currentReach: number;
  /**
   * Whether the reader was at the bottom BEFORE the growth.
   *
   * It must be the earlier value, and it is: nothing recomputes it without a scroll event, and
   * content growing under a stationary reader fires none.
   */
  wasNearBottom: boolean;
  /** Older messages are being prepended - `loadOlderGroups` restores the position itself. */
  isLoadingOlder: boolean;
  /** The conversation is still being entered - `fillViewportThenPin` owns the position until it is not. */
  isEntering: boolean;
}

/**
 * THE QUANTITY "THE BOTTOM MOVED" IS MEASURED IN: the largest `scrollTop`, `scrollHeight -
 * clientHeight`.
 *
 * `scrollHeight` alone sees the content (and the composer's `padding-bottom`) grow, and the bottom
 * of a thread also moves when the PANE'S OWN BOX shrinks under unchanged content - the soft keyboard
 * rising, a side panel opening, a window resize. The box lost its height, `scrollHeight` did not
 * move, nothing "grew", the reader kept their `scrollTop` and the last messages ended under the
 * keyboard (production 1.1.2, Android, user 2026-10-09). A viewport change is a change of extent
 * like any other, and this is the one number all of them move.
 */
export function threadReach(metrics: ThreadScrollMetrics): number {
  return metrics.scrollHeight - metrics.clientHeight;
}

/**
 * What one observed change of the thread's extent does to the reader's position.
 *
 * - `follow-bottom`: the reader was at the bottom and the reach moved - pin it back to the bottom.
 * - `hold-bottom`: the reader was at the bottom and nothing moved the reach - nothing to do, and in
 *   particular NO anchor compensation (see below).
 * - `keep-row`: the reader is reading history (or the component owns the position): the row at the
 *   top of the viewport is kept where it is ({@link anchorShift}).
 */
export type ThreadGrowthResponse = 'follow-bottom' | 'hold-bottom' | 'keep-row';

/**
 * Decides {@link ThreadGrowthResponse} for one change.
 *
 * **A READER AT THE BOTTOM IS ANCHORED TO THE BOTTOM, IN BOTH DIRECTIONS** (owner's Pixel 6a and a
 * friend's phone on 1.5.1, 2026-10-30; reproduced on the Mi 9T). Only GROWTH used to be followed; a
 * SHRINK fell through to the row anchor, which keeps the row at the top of the viewport in place.
 * On Android the soft keyboard resizes the WebView itself, so every `svh` length shrinks with it -
 * and a photo sits under the `--media-max-height: 60svh` ceiling. The keyboard's first frame pinned
 * the thread; the next, the WebView's own resize, shrank the photo by 0.6 x the keyboard (214 px of a
 * 357 px keyboard on the Mi 9T), the rows below it moved up, and the anchor "kept the reader's row"
 * by scrolling the pane UP by those 214 px: the last messages went under the composer and the
 * scroll-down arrow appeared. A text-only thread has no viewport-relative row and never showed it.
 *
 * For a reader at the bottom the bottom IS the anchor: any change of reach is followed.
 */
export function threadGrowthResponse(growth: ThreadGrowth): ThreadGrowthResponse {
  // PREPENDING IS GROWTH THAT MEANS THE OPPOSITE. `loadOlderGroups` adds height ABOVE the reader and
  // restores `scrollTop` by exactly that much; following the bottom here would throw away the
  // history it had just fetched and land them where they already were.
  if (growth.isLoadingOlder) return 'keep-row';
  if (growth.isEntering) return 'keep-row';
  if (!growth.wasNearBottom) return 'keep-row';
  return growth.currentReach === growth.previousReach ? 'hold-bottom' : 'follow-bottom';
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

/** What a change of the soft keyboard may do to the thread (`keyboardChangeResponse`). */
export interface KeyboardChange {
  wasOpen: boolean;
  isOpen: boolean;
  /** The composer's text field holds focus - BEFORE this change too, since a rise fires no focus. */
  composerFocused: boolean;
  /** Whether the reader was at the live end BEFORE the change. */
  isNearBottom: boolean;
}

/**
 * WHETHER A KEYBOARD RISING OR FALLING TAKES THE THREAD TO ITS LAST MESSAGE.
 *
 * **A KEYBOARD RISING FOR THE COMPOSER IS THE COMPOSER BEING TAKEN UP, whether or not a focus event
 * came with it.** Focusing the field already goes to the end (`ChatArea`), from any distance. But an
 * Android WebView keeps the field FOCUSED when the keyboard is put away (Back, Gboard's arrow), so the
 * next tap on it raises the keyboard with no focus event at all - and this used to follow only a
 * reader within {@link THREAD_BOTTOM_SLACK_PX} of the bottom. A reader a little higher kept their
 * `scrollTop`, the pane lost the keyboard's height at its bottom edge, and the last messages ended
 * behind the keyboard (Mi 9T, 1.5.1-alpha.7, 2026-10-29: 138 px from the bottom before the rise,
 * 483 after; the owner's report on 1.5.0). So the rise answers like the focus does.
 *
 * A keyboard FALLING moves only a reader at the bottom - one reading history is left where they are.
 */
export function keyboardChangeResponse(change: KeyboardChange): 'follow-bottom' | 'stay' {
  if (!change.wasOpen && change.isOpen && change.composerFocused) return 'follow-bottom';
  if (change.wasOpen && !change.isOpen && change.isNearBottom) return 'follow-bottom';
  return 'stay';
}

/**
 * WHAT A NEW MESSAGE MAY DO TO THE READER'S POSITION.
 *
 * `ChatArea` had this as a three-armed `if` inside an `$effect`, and `useMessaging` had a fourth
 * opinion: three bare `chatContainer.scrollTop = chatContainer.scrollHeight` - one after every
 * message persisted, one after every batch, one when a catch-up drain finished. They asked nothing
 * and were not even scoped to a conversation, so a batch landing in a thread the reader did not
 * have open still yanked the thread they were reading to the bottom. On a bad connection, where
 * frames trickle in for minutes, that is the reading experience.
 *
 * ONE PREDICATE, AND IT IS THE ONE BOOLEAN. Everything here is decided by `isNearBottom`, which
 * `handleScroll` is the only writer of, plus the two states in which the component itself owns the
 * position (`entering`, and a catch-up the reader has not scrolled away from).
 */
export type NewMessageResponse =
  /** Re-run the entry pin: the window has to move with the list before the pane can. */
  | 'repin-entry'
  /** An ordinary live message on a thread the reader is sitting at the bottom of. */
  | 'follow-bottom'
  /** The reader has gone up to read. Nothing moves; the unread pill says the rest. */
  | 'stay';

export interface NewMessageState {
  /** The conversation is still being entered - `fillViewportThenPin` owns the position. */
  entering: boolean;
  /** A history replay or a bulk drain is running. */
  catchupActive: boolean;
  /** Whether the reader was at the live end BEFORE this message. */
  isNearBottom: boolean;
  /** The message that just landed is the reader's own, which always follows. */
  ownMessageAdded: boolean;
}

export function respondToNewMessage(state: NewMessageState): NewMessageResponse {
  if (state.entering) return 'repin-entry';
  if (state.catchupActive) {
    // A CATCH-UP IS NOT A LICENCE TO MOVE SOMEBODY. The initial page arriving late still has to
    // re-pin, which is what `isNearBottom` says while nobody has scrolled; a reader who HAS gone
    // up is reading history, and a drain finishing is not a reason to take that away.
    return state.isNearBottom || state.ownMessageAdded ? 'repin-entry' : 'stay';
  }
  return state.isNearBottom || state.ownMessageAdded ? 'follow-bottom' : 'stay';
}

/**
 * HOW MUCH CONTENT APPEARED ABOVE THE READER, so their row can be put back where it was.
 *
 * Three mechanisms prepend into this scroller and only one of them compensated. `loadOlderGroups`
 * restores `scrollTop` explicitly for the IndexedDB page; the render window stepping up by 140
 * groups did not, and neither did a PEER scrollback answer - which does not even arrive as a
 * return value, but later, as an ordinary bundle. So a reader who asked for older history was slid
 * down the page by exactly the height of what they had asked for.
 *
 * THE ANCHOR IS A ROW, NOT A NUMBER. `scrollTop` cannot tell a prepend from an append - both grow
 * `scrollHeight` and leave `scrollTop` alone - so the caller keeps a reference to a row it has
 * already measured and asks how far that row moved. Anything above it growing or shrinking, for any
 * reason, is the same correction: the thing the reader is looking at stays where it is. The row is
 * the one at the TOP OF THE VIEWPORT ({@link firstRowBelow}), the same choice CSS scroll anchoring
 * makes - which this pane cannot use, because WebKit shipped `overflow-anchor` only in Safari 27.
 */
export interface ThreadAnchorShift {
  /** The anchor row's `offsetTop` when it was last measured, or `null` if there was no anchor. */
  previousTop: number | null;
  /** Its `offsetTop` now, or `null` if the row is gone from the document. */
  currentTop: number | null;
  /** The component owns the position while entering; nothing is compensated then. */
  isEntering: boolean;
}

export function anchorShift(shift: ThreadAnchorShift): number {
  if (shift.isEntering) return 0;
  if (shift.previousTop === null || shift.currentTop === null) return 0;
  // SIGNED SINCE THE ANCHOR IS THE ROW THE READER SEES (2026-10-02). While it was the topmost
  // RENDERED row, only a prepend could move it, and only downward. The row at the top of the
  // viewport also moves when a medium ABOVE it settles - an old message's frame taking its measured
  // ratio, which can be shorter than the fallback as well as taller - and the reader's place is lost
  // either way, so either way is undone.
  return shift.currentTop - shift.previousTop;
}

/**
 * The index of the first row whose bottom edge is below `line` - the row at the top of the
 * viewport when `line` is the scroller's top - or `-1` when every row is above it. Rows are in
 * document order, so their bottoms only increase and a binary search reads `log n` of them: this
 * runs inside a layout observer, once per change.
 */
export function firstRowBelow(
  count: number,
  bottomOf: (index: number) => number,
  line: number
): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bottomOf(mid) > line) hi = mid;
    else lo = mid + 1;
  }
  return lo < count ? lo : -1;
}

/**
 * The `[CHAT_VIEW]` diagnostic line for ONE change of the displayed conversation's message count,
 * or null when the count did not change. It pairs with `[ADD_MSG] Batch into ... selected=<bool>`:
 * the first says the conversation map took the message, this one says the pane's prop received it.
 * `response` is the scroll decision for a growth and `n/a` for a shrink.
 */
export function chatViewCountLine(
  conversationId: string,
  previousCount: number,
  count: number,
  response: NewMessageResponse | null
): string | null {
  if (count === previousCount) return null;
  return `${conversationId.slice(0, 8)} messages ${count} (hasNewMessage=${count > previousCount}, response=${response ?? 'n/a'})`;
}
