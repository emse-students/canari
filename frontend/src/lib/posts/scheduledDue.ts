import type { ScheduledPost } from './api';

/** The longest delay `setTimeout` honours (a 32-bit signed int of ms); a longer one fires at once. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Milliseconds until the earliest scheduled post falls due, derived from the posts' own timestamps
 * (nothing polls). `null` when nothing is scheduled. Never negative, and capped at
 * {@link MAX_TIMER_MS} - the caller re-evaluates when the timer fires, so a capped wait is just an
 * early wake-up that arms the next one.
 */
export function msUntilNextDue(
  posts: readonly Pick<ScheduledPost, 'scheduledAt'>[],
  now: number
): number | null {
  let earliest: number | null = null;
  for (const p of posts) {
    const t = new Date(p.scheduledAt).getTime();
    if (Number.isNaN(t)) continue;
    if (earliest === null || t < earliest) earliest = t;
  }
  if (earliest === null) return null;
  return Math.min(Math.max(earliest - now, 0), MAX_TIMER_MS);
}

/** The posts whose scheduled time has not come yet - what the "scheduled" strip may still list. */
export function stillScheduled<T extends Pick<ScheduledPost, 'scheduledAt'>>(
  posts: readonly T[],
  now: number
): T[] {
  return posts.filter((p) => new Date(p.scheduledAt).getTime() > now);
}
