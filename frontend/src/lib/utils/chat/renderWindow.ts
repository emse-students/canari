/**
 * The chat renders a WINDOW over the grouped messages rather than the whole conversation: a
 * thousand bubbles in one synchronous pass delays layout and the entry scroll overshoots. The
 * window is a pair (start, count) into `messageGroups`, and `start` is state - it moves when the
 * user paginates upwards.
 *
 * That makes it a pointer into an array somebody else owns, which is the whole problem this module
 * exists to solve: `conversation.messages` is REPLACED, not appended to, by every path that reloads
 * a page from the local store after a network replay. When the replacement is shorter than what was
 * in memory, a `start` computed against the old length points past the new end, `slice` returns
 * nothing, and the conversation renders its header and composer with no messages at all - no error,
 * no skeleton, no empty state. Only remounting the component recomputes `start`, which is why
 * leaving the conversation and coming back "fixes" it and reads as a data fault when it is not one.
 *
 * So the read side never trusts the stored `start`: it is clamped against the CURRENT group count
 * on every render. The invariant is worth stating plainly, because it is what the tests pin:
 *
 *   a non-empty list always yields a non-empty window.
 */

/**
 * Clamps a stored window start against the current group count.
 *
 * @param windowStart Stored start index, possibly computed against an older, longer list.
 * @param groupCount Number of message groups currently in the list.
 * @param initialGroups Size of the entry window - the tail the reader expects to land on.
 * @returns A start index that is always a valid position in the current list.
 */
export function clampWindowStart(
  windowStart: number,
  groupCount: number,
  initialGroups: number
): number {
  if (!Number.isFinite(windowStart) || windowStart <= 0) return 0;
  if (groupCount <= 0) return 0;
  // The furthest a window may legitimately start: any further and the reader would see fewer than
  // one screenful of a list that has more to show.
  const lastEntryStart = Math.max(0, groupCount - Math.max(0, initialGroups));
  return Math.min(Math.floor(windowStart), lastEntryStart);
}

/**
 * Resolves the slice bounds of the render window.
 *
 * THE END IS THE END OF THE LIST, ALWAYS. It used to be `start + maxGroups`, a fixed-width window
 * that SLID: every step upwards walked the end up too, so past `maxGroups` groups the newest
 * messages left the DOM. Three things were wrong with that, and only the first was visible at
 * first. Nothing walked the end back, so scrolling down could not return to the present - reported
 * 2026-09-09 as "the recent messages disappear and I cannot scroll back to them". Adding a downward
 * step fixed that case and left the second: `scrollHeight` is the height of the RENDERED slice, so
 * a window that slides makes the scrollbar describe a conversation that changes size while the
 * reader scrolls - measured oscillating 1010 -> 1940 -> 1546 -> 1524 with no content change, and
 * the user named it before the measurement did. And the third is that every slide needs the scroll
 * position compensated, which is a correction that has to be right for insertions at one end and
 * removals at the other simultaneously - it was not, and could not be made so cheaply.
 *
 * Anchoring the end deletes all three at once. The window only ever GROWS, upwards, by exactly the
 * pages the reader walked through; nothing is ever removed, so nothing has to be put back, the
 * scrollbar only ever grows at the top where `loadOlderGroups` already compensates, and the newest
 * message is in the DOM at every instant. What bounds the work is the reader's own scrolling, one
 * page per gesture, which is the bound that matters for "a conversation of any size": the cost is
 * proportional to what somebody actually looked at, not to what the conversation holds.
 *
 * @param windowStart Stored start index (clamped internally - callers pass their raw state).
 * @param groupCount Number of message groups currently in the list.
 * @param initialGroups Size of the entry window.
 * @returns `{ start, end }`, usable directly as `slice(start, end)` arguments.
 */
export function resolveRenderWindow(
  windowStart: number,
  groupCount: number,
  initialGroups: number
): { start: number; end: number } {
  const start = clampWindowStart(windowStart, groupCount, initialGroups);
  return { start, end: Math.max(0, groupCount) };
}

/**
 * The window start after one page towards the OLDER end.
 *
 * @param currentStart The window's current start - the RESOLVED one, never the stored state: after
 *   the list has been replaced by a shorter page the two differ, and stepping back from the stale
 *   one walks a window that is already past the end.
 * @param step How many groups one page is worth.
 */
export function stepWindowOlder(currentStart: number, step: number): number {
  return Math.max(0, currentStart - Math.max(1, step));
}
