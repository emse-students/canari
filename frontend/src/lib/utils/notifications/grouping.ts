import type { PostNotification } from '$lib/posts/api';

/**
 * The buckets a notification list is drawn in, newest band first.
 *
 * `new` is not an age - it is "unread when this view opened", which is why the caller passes the
 * snapshot rather than the list deciding for itself. Both notification surfaces mark everything read
 * as they open, so a bucket derived from `notif.read` would be empty by the time it rendered.
 */
export type NotificationBucket = 'new' | 'today' | 'week' | 'earlier';

/** The bucket order, exported so a renderer cannot invent a different one. */
export const NOTIFICATION_BUCKETS: readonly NotificationBucket[] = [
  'new',
  'today',
  'week',
  'earlier',
] as const;

/** One band of the list: a bucket and the notifications that fell in it, in the given order. */
export interface NotificationGroup {
  bucket: NotificationBucket;
  items: PostNotification[];
}

/**
 * Which band a single notification belongs to.
 *
 * `today` is the same CALENDAR day, not the last 24 hours: something posted at 23:50 yesterday is
 * "yesterday" to a reader at 00:10 whatever the elapsed minutes say. `week` is then the following
 * six days, measured in whole days from the start of today so it cannot drift with the clock.
 *
 * @param notif - the notification to place
 * @param unreadIds - ids that were unread when the view opened
 * @param now - the reference instant, injected so a test never asserts a wall clock
 */
export function bucketOf(
  notif: PostNotification,
  unreadIds: ReadonlySet<string>,
  now: Date
): NotificationBucket {
  if (unreadIds.has(notif.id)) return 'new';

  const created = new Date(notif.createdAt);
  if (Number.isNaN(created.getTime())) return 'earlier';

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (created.getTime() >= startOfToday) return 'today';

  const MS_PER_DAY = 86_400_000;
  if (created.getTime() >= startOfToday - 6 * MS_PER_DAY) return 'week';
  return 'earlier';
}

/**
 * Splits a notification list into its bands, dropping any band that would render empty.
 *
 * The input order is preserved inside each band: the API already returns newest first, and
 * re-sorting here would quietly override that decision.
 *
 * @param notifications - the list to split, newest first
 * @param unreadIds - ids that were unread when the view opened
 * @param now - the reference instant, injected so a test never asserts a wall clock
 */
export function groupNotifications(
  notifications: readonly PostNotification[],
  unreadIds: ReadonlySet<string>,
  now: Date
): NotificationGroup[] {
  const byBucket = new Map<NotificationBucket, PostNotification[]>();
  for (const notif of notifications) {
    const bucket = bucketOf(notif, unreadIds, now);
    const items = byBucket.get(bucket);
    if (items) items.push(notif);
    else byBucket.set(bucket, [notif]);
  }
  return NOTIFICATION_BUCKETS.filter((b) => byBucket.has(b)).map((bucket) => ({
    bucket,
    items: byBucket.get(bucket) as PostNotification[],
  }));
}
