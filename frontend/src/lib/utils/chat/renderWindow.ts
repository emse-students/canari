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
 * @param windowStart Stored start index (clamped internally - callers pass their raw state).
 * @param groupCount Number of message groups currently in the list.
 * @param initialGroups Size of the entry window.
 * @param maxGroups Hard cap on rendered groups, to bound DOM nodes.
 * @returns `{ start, end }`, usable directly as `slice(start, end)` arguments.
 */
export function resolveRenderWindow(
  windowStart: number,
  groupCount: number,
  initialGroups: number,
  maxGroups: number
): { start: number; end: number } {
  const start = clampWindowStart(windowStart, groupCount, initialGroups);
  const end = Math.min(Math.max(0, groupCount), start + Math.max(1, maxGroups));
  return { start, end };
}
