/**
 * THE instant a post became (or will become) visible: its `scheduledAt` when it has one, else `now`.
 *
 * `publishedAt` is the one key the feed orders by, pages by and the card displays. It is derived
 * here, once, from the same column the visibility predicate (`scheduledAt <= NOW()`) reads, so a
 * scheduled post surfaces at its scheduled time in the right place and there is no publisher job
 * whose lateness could disagree with it. `createdAt` stays what it says: when the row was written.
 */
export function publicationTime(scheduledAt: Date | string | null | undefined, now: Date): Date {
  return scheduledAt ? new Date(scheduledAt) : now;
}

/**
 * THE feed's one definition of "published", as SQL on the DATABASE clock: no `scheduledAt`, or one
 * that has passed. Anything asking "may this post be acted on yet" reads this, never the app clock
 * and never `publishedAt` (which can be out of step with `scheduledAt`). `posts` is the table name.
 */
export const PUBLISHED_SQL = `(posts."scheduledAt" IS NULL OR posts."scheduledAt" <= NOW())`;
