/** What the strip needs of a post: when it is due. `null`/absent is "not scheduled". */
export interface DueAt {
  scheduledAt?: string | null;
}

/** The longest delay `setTimeout` honours (a 32-bit signed int of ms); a longer one fires at once. */
export const MAX_TIMER_MS = 2_147_483_647;

/** The due time as a number; NaN for a post that is not scheduled or carries an unreadable date. */
function dueTime(p: DueAt): number {
  return p.scheduledAt ? new Date(p.scheduledAt).getTime() : Number.NaN;
}

/**
 * Milliseconds until the earliest scheduled post falls due, derived from the posts' own timestamps
 * (nothing polls). `null` when nothing is scheduled. Never negative, and capped at
 * {@link MAX_TIMER_MS} - the caller re-evaluates when the timer fires, so a capped wait is just an
 * early wake-up that arms the next one.
 */
export function msUntilNextDue(posts: readonly DueAt[], now: number): number | null {
  let earliest: number | null = null;
  for (const p of posts) {
    const t = dueTime(p);
    if (Number.isNaN(t)) continue;
    if (earliest === null || t < earliest) earliest = t;
  }
  if (earliest === null) return null;
  return Math.min(Math.max(earliest - now, 0), MAX_TIMER_MS);
}

/** The posts whose scheduled time has not come yet - what the "scheduled" strip may still list. */
export function stillScheduled<T extends DueAt>(posts: readonly T[], now: number): T[] {
  return posts.filter((p) => dueTime(p) > now);
}

/**
 * The strip after one of its posts was edited. A post still scheduled in the future takes the edit
 * IN PLACE of its old row and the list is re-sorted soonest first; one the edit published now (or
 * un-scheduled) leaves the strip and `published` tells the caller to re-read the feed, where the
 * server now serves it.
 */
export function applyScheduledEdit<T extends DueAt & { id: string }>(
  posts: readonly T[],
  edited: T,
  now: number
): { posts: T[]; published: boolean } {
  const rest = posts.filter((p) => p.id !== edited.id);
  if (!(dueTime(edited) > now)) return { posts: rest, published: true };
  const next = [...rest, edited].sort((a, b) => dueTime(a) - dueTime(b));
  return { posts: next, published: false };
}
