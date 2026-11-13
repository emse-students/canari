/**
 * Where a reader stood in a conversation when they left it, kept for the session so that coming back
 * from a profile (the route unmounts the thread) lands them on the same message.
 *
 * **THE ANCHOR IS WRITTEN WHEN THE READER LEAVES AND READ WHEN THEY ENTER - NEVER BY A CLOCK OR A
 * SCROLL LISTENER.** It is a message id (the first row in view), the thread's render-window start
 * (the id's row may sit above the entry window), and how far the row's top was from the top of the
 * visible thread. The entry decision, {@link resolveEntryAnchor}, is a pure function so the three
 * cases - an anchor that holds, none, a stale one - are testable without a layout engine.
 *
 * Held in memory only (a reload starts at the usual entry), consumed by the entry that reads it (a
 * second entry from the list opens as today), and dropped at sign-out with the other per-account
 * stores (`clearUserLocally`).
 */

/** One conversation's saved position. */
export interface ConversationAnchor {
  /** The first message row in view when the reader left. */
  messageId: string;
  /** The render window's start (a group index) at that moment. */
  windowStart: number;
  /** Row top minus the visible thread's top, in px: negative when the row was partly above it. */
  offsetPx: number;
  /**
   * The conversation's newest message id when the reader left. A different newest message at the
   * return means something arrived meanwhile, and the reader belongs at the usual entry (first
   * unread) - the anchor serves only the IMMEDIATE return, decided by this fact and not by a clock.
   */
  lastMessageId: string | null;
}

const conversationAnchors = new Map<string, ConversationAnchor>();

/** Saves (or, with `null`, forgets) the position a reader left `conversationId` at. */
export function rememberConversationAnchor(
  conversationId: string,
  anchor: ConversationAnchor | null
): void {
  if (anchor === null) conversationAnchors.delete(conversationId);
  else conversationAnchors.set(conversationId, anchor);
}

/** The saved position, left in place: a caller that may not be able to use it yet looks first. */
export function peekConversationAnchor(conversationId: string): ConversationAnchor | null {
  return conversationAnchors.get(conversationId) ?? null;
}

/**
 * Erases every saved position except `conversationId`'s. Called at each conversation entry: an
 * anchor serves the return from a profile to the SAME conversation, so an entry of another one
 * (A -> profile -> B) ends A's.
 *
 * @returns How many were dropped (for the log).
 */
export function dropAnchorsExcept(conversationId: string): number {
  let dropped = 0;
  // Deleting the entry being visited is defined for a Map: the iteration goes on with the next one.
  for (const id of conversationAnchors.keys()) {
    if (id === conversationId) continue;
    conversationAnchors.delete(id);
    dropped++;
  }
  return dropped;
}

/** Returns the saved position and ERASES it: one return restores one position. */
export function takeConversationAnchor(conversationId: string): ConversationAnchor | null {
  const anchor = conversationAnchors.get(conversationId) ?? null;
  conversationAnchors.delete(conversationId);
  return anchor;
}

/** Drops every saved position (sign-out). */
export function clearConversationAnchors(): void {
  conversationAnchors.clear();
}

/**
 * The index of the first row whose bottom edge is below `limit` - the first row any part of which is
 * in view - or -1. Rows are in DOM order so their bottoms increase: a binary search reads O(log n)
 * rects. `bottomOf` is read lazily for that reason.
 */
export function firstRowEndingBelow(
  count: number,
  bottomOf: (index: number) => number,
  limit: number
): number {
  let lo = 0;
  let hi = count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bottomOf(mid) > limit) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found;
}

/** What the entry does with a saved anchor. */
export type EntryAnchorDecision =
  | { kind: 'bottom'; reason: 'none' | 'message-not-in-list' | 'newer-messages' }
  | { kind: 'restore'; windowStart: number; messageId: string; offsetPx: number };

/**
 * The ONE decision between "open where the reader left" and the usual entry (first unread / bottom).
 *
 * @param anchor The position taken for this conversation, or `null` when none was saved.
 * @param targetGroupIndex Where the anchor's message sits in the CURRENT groups, -1 if it is gone
 *   (deleted, or older than the list now in memory). A gone message is the one stale case, and the
 *   caller logs it: a fallback is a signal.
 * @param groupCount Number of groups now.
 * @param currentLastMessageId The conversation's newest message id now; one that differs from the
 *   anchor's means messages arrived since the reader left, and the restore is declined.
 * @returns A `restore` whose `windowStart` is at most the target's group (so the row is mounted) and
 *   never past the list, or a `bottom` naming why.
 */
export function resolveEntryAnchor(
  anchor: ConversationAnchor | null,
  targetGroupIndex: number,
  groupCount: number,
  currentLastMessageId: string | null
): EntryAnchorDecision {
  if (anchor === null) return { kind: 'bottom', reason: 'none' };
  if (targetGroupIndex < 0 || targetGroupIndex >= groupCount) {
    return { kind: 'bottom', reason: 'message-not-in-list' };
  }
  if (anchor.lastMessageId !== currentLastMessageId) {
    return { kind: 'bottom', reason: 'newer-messages' };
  }
  const stored = Number.isFinite(anchor.windowStart) ? Math.floor(anchor.windowStart) : 0;
  return {
    kind: 'restore',
    windowStart: Math.max(0, Math.min(stored, targetGroupIndex)),
    messageId: anchor.messageId,
    offsetPx: Number.isFinite(anchor.offsetPx) ? anchor.offsetPx : 0,
  };
}
