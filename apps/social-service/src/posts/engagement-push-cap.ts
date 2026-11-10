import type { EntityManager } from 'typeorm';

/**
 * THE DAILY CAP ON ENGAGEMENT PUSHES (engagement WP-8, decisions 6 and 11; docs/wiki/engagement.md,
 * "The noise budget - a daily cap from a counter row").
 *
 * Beyond {@link ENGAGEMENT_DAILY_PUSH_CAP} engagement pushes per person per Paris day, the rest stay
 * in the in-app bell with no push. ONLY the NEW kinds are capped (decision 11) - friends' activity
 * and campus trends; nothing that existed before the chantier is counted, nor shotgun openings,
 * nor anything addressed to the reader (messages, mentions, replies, comments and reactions on their
 * own content, calls - L5).
 *
 * DURABLE STATE, NOT A TIMER: one counter row per (person, Paris date read from the DATABASE - L6),
 * incremented by the one statement below; a new day is a new row and nothing resets anything. The
 * daily notifications GC deletes rows older than {@link ENGAGEMENT_PUSH_DAYS_KEPT} days.
 */

/**
 * How many engagement pushes one person receives per day. 5 is roughly one per waking slot; R2,
 * read on production 2026-11-09 (the upper bound of what friends' activity would have pushed: per
 * reader-day p50 2, p90 5, p99 12), keeps it: it binds on the busiest days, as intended.
 */
export const ENGAGEMENT_DAILY_PUSH_CAP = 5;

/** How many days of counter rows the daily GC keeps. */
export const ENGAGEMENT_PUSH_DAYS_KEPT = 7;

/** Friends' activity (WP-9): an account the reader follows reacted to a post they see. */
export const FRIEND_REACTION_NOTIFICATION = 'friend_reaction';
/** Friends' activity (WP-9): an account the reader follows commented on a post they see. */
export const FRIEND_COMMENT_NOTIFICATION = 'friend_comment';
/** A campus trend (WP-10): a post of the reader's space took off. */
export const CAMPUS_TREND_NOTIFICATION = 'campus_trend';

/**
 * THE CAPPED PUSH TYPES, and the notification category each files under - ONE map, so the category
 * the cap reads before counting and the one chat-delivery applies at the send cannot disagree; a
 * contract test pins every entry against chat-delivery's `push-category.ts` through its content key.
 * An ALLOWLIST: a type absent here is never counted and never capped.
 *
 * - `friend_reaction` and `friend_comment` (WP-9, decision 5b, friends' activity): an account the
 *   reader follows reacted to or commented on a post - two types, one native sentence each. Files
 *   under `posts` (L30): it is news about a post of someone else, not a reaction to or a comment on
 *   the reader's own, which is what `reactions` and `comments` switch off.
 * - `campus_trend` (WP-10, decision 5c): a post of the reader's space took off - `posts` too.
 */
export const ENGAGEMENT_PUSH_TYPES: ReadonlyMap<string, { contentKey: string; category: string }> =
  new Map([
    [FRIEND_REACTION_NOTIFICATION, { contentKey: 'social_friend_reaction', category: 'posts' }],
    [FRIEND_COMMENT_NOTIFICATION, { contentKey: 'social_friend_comment', category: 'posts' }],
    [CAMPUS_TREND_NOTIFICATION, { contentKey: 'social_campus_trend', category: 'posts' }],
  ]);

/**
 * The one statement of a capped fan-out: for every DISTINCT recipient (a fan-out that names a
 * reader twice would make `ON CONFLICT DO UPDATE` touch one row twice, which PostgreSQL refuses), in
 * ONE lock order (two concurrent fan-outs over overlapping readers can then never deadlock, and the
 * row lock orders them on each shared reader, so the cap is exact), skipping a reader who switched
 * the type's category off (`notification_preference`, chat-delivery's table in the same database:
 * they are never pushed, so they must not spend the budget), one unit of today's budget is taken
 * while it lasts. `RETURNING` names the readers who got one - the others keep their bell row only.
 *
 * `$1` the recipients, `$2` the cap, `$3` the category.
 */
export const CLAIM_ENGAGEMENT_PUSHES_SQL = `INSERT INTO engagement_push_days ("userId", day, pushed)
SELECT ids.r, (now() AT TIME ZONE 'Europe/Paris')::date, 1
  FROM (SELECT DISTINCT r FROM unnest($1::varchar[]) r) ids
 WHERE NOT EXISTS (SELECT 1 FROM notification_preference np
                    WHERE np."userId" = ids.r AND np."disabledCategories" ? $3::text)
 ORDER BY ids.r
ON CONFLICT ("userId", day) DO UPDATE SET pushed = engagement_push_days.pushed + 1
  WHERE engagement_push_days.pushed < $2::int
RETURNING "userId"`;

/** The daily GC's statement: counter rows older than {@link ENGAGEMENT_PUSH_DAYS_KEPT} days, counted. */
export const PRUNE_ENGAGEMENT_PUSH_DAYS_SQL = `WITH gone AS (
  DELETE FROM engagement_push_days
   WHERE day < (now() AT TIME ZONE 'Europe/Paris')::date - ${ENGAGEMENT_PUSH_DAYS_KEPT}
  RETURNING 1)
SELECT count(*)::int AS n FROM gone`;

/** Deletes the counter rows the cap no longer reads; answers how many. */
export async function pruneEngagementPushDays(
  manager: Pick<EntityManager, 'query'>
): Promise<number> {
  const rows: { n: number }[] = await manager.query(PRUNE_ENGAGEMENT_PUSH_DAYS_SQL);
  return rows[0]?.n ?? 0;
}

/**
 * Takes one unit of today's budget for each of `recipients` who still has one and has not switched
 * `category` off; answers who may be pushed. One statement, whatever the fan-out's size.
 */
export async function claimEngagementPushes(
  manager: Pick<EntityManager, 'query'>,
  recipients: readonly string[],
  category: string
): Promise<Set<string>> {
  if (recipients.length === 0) return new Set();
  const rows: { userId: string }[] = await manager.query(CLAIM_ENGAGEMENT_PUSHES_SQL, [
    recipients,
    ENGAGEMENT_DAILY_PUSH_CAP,
    category,
  ]);
  return new Set(rows.map((r) => r.userId));
}
