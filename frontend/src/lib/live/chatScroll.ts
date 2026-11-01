/**
 * THE LIVE CHAT'S SCROLL RULE, as plain functions: the list follows its newest line ONLY when the
 * reader is already at the bottom. It is a fact about the scroll position, never a timer: a reader
 * who scrolled up to read back is not yanked down, and is told how many lines arrived meanwhile
 * (the "new messages" chip) until they come back to the bottom themselves.
 */

/** How far from the bottom still counts as "at the bottom" - a fingertip's slack, in CSS pixels. */
export const CHAT_BOTTOM_SLACK = 24;

/** The three numbers of a scroll container the rule reads. */
export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/** Whether the container shows its bottom edge (within {@link CHAT_BOTTOM_SLACK}). */
export function isAtBottom(el: ScrollMetrics): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < CHAT_BOTTOM_SLACK;
}

/**
 * What to do when `added` lines arrived: follow them (the reader is at the bottom) or count them as
 * unseen (the reader is reading back). The count only grows while reading back and is zero
 * whenever following.
 */
export function onLinesAdded(
  pinned: boolean,
  unseen: number,
  added: number
): { follow: boolean; unseen: number } {
  if (added <= 0) return { follow: false, unseen };
  return pinned ? { follow: true, unseen: 0 } : { follow: false, unseen: unseen + added };
}
