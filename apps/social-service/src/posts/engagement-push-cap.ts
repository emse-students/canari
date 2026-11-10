import type { EntityManager } from 'typeorm';
import {
  PUSH_KEY_MIN_CLIENT,
  type NotificationType,
  type PushOnlyNotificationType,
} from '../push/notification-client-floor';
import type { PushContentKey } from '../push/push-content';

/**
 * THE GLOBAL DAILY PUSH CAP (engagement WP-8; owner, 2026-11-10: "on y est allés un peu fort";
 * docs/wiki/engagement.md, "The noise budget - a daily cap from a counter row").
 *
 * Beyond {@link ENGAGEMENT_DAILY_PUSH_CAP} non-essential pushes per person per Paris day, the rest
 * stay in the in-app bell with no push. WHAT IS COUNTED IS ONE TABLE, {@link PUSH_BUDGET}: every
 * notification type, classified - the engagement-only kinds count (trends, reactions and comments
 * on your posts, member reposts, followed accounts' posts, openings), and everything a person needs
 * or asked for does not (messages and calls never pass here, bookings, follow requests, mentions and
 * replies, moderation and organiser workflow, birthdays, association posts).
 *
 * DURABLE STATE, NOT A TIMER: one counter row per (person, Paris date read from the DATABASE - L6),
 * incremented by the one statement below; a new day is a new row and nothing resets anything. The
 * daily notifications GC deletes rows older than {@link ENGAGEMENT_PUSH_DAYS_KEPT} days.
 */

/**
 * How many counted pushes one person receives per Paris day: 3 (owner, 2026-11-10), down from the
 * 5 that capped campus trends alone, now that the cap spans every engagement-only kind.
 */
export const ENGAGEMENT_DAILY_PUSH_CAP = 3;

/** How many days of counter rows the daily GC keeps. */
export const ENGAGEMENT_PUSH_DAYS_KEPT = 7;

/**
 * Friends' activity (WP-9): an account the reader follows reacted to a post they see. No longer
 * written (owner, 2026-11-10: the trend names the friends instead); the type stays for the rows
 * already in bells and for the clients that draw them.
 */
export const FRIEND_REACTION_NOTIFICATION = 'friend_reaction';
/** Friends' activity (WP-9): an account the reader follows commented. No longer written, as above. */
export const FRIEND_COMMENT_NOTIFICATION = 'friend_comment';
/** A campus trend (WP-10): a post of the reader's space took off. */
export const CAMPUS_TREND_NOTIFICATION = 'campus_trend';

/**
 * Where a type stands against the daily cap. A COUNTED type names the content keys its push is
 * sent under and the notification category chat-delivery files them under - the cap reads that
 * category before counting (a reader who switched it off is never pushed, so never spends a unit),
 * and a contract test pins it against chat-delivery's `push-category.ts` through EACH key.
 */
export type PushBudget =
  | { counted: false }
  | { counted: true; contentKeys: readonly PushContentKey[]; category: string };

const FREE: PushBudget = { counted: false };
const counted = (category: string, ...contentKeys: PushContentKey[]): PushBudget => ({
  counted: true,
  contentKeys,
  category,
});

/**
 * EVERY NOTIFICATION TYPE, CLASSIFIED (owner, 2026-11-10) - a `Record` over the whole union, so a
 * new type does not compile until it is placed here, and a test asserts the same at run time.
 *
 * COUNTED - the lead's list, shown to the owner on 2026-11-10: campus trends, reactions and comments
 * on your posts, member reposts, followed accounts' posts, booking and event openings, and friends'
 * activity (no longer written).
 *
 * NOT COUNTED, the owner's list: bookings (reminders and changes), follow requests and acceptances,
 * direct mentions and replies, moderation and the organiser workflow, BIRTHDAYS, ASSOCIATION POSTS
 * (and their reposts) - and messages and calls, which chat-delivery sends and never pass here.
 * The lead's placements, written in engagement.md: a live STARTING is not counted (it is worth only
 * in its moment, and an account's bell already reduces it), nor a FORM opening (the reader asked
 * for that reminder by pressing "Me rappeler"); a repost or co-organisation PROPOSED is workflow.
 */
export const PUSH_BUDGET: Readonly<
  Record<NotificationType | PushOnlyNotificationType, PushBudget>
> = {
  // Counted: engagement-only.
  campus_trend: counted(
    'suggestions',
    'social_campus_trend',
    'social_campus_trend_photo',
    'social_campus_trend_video'
  ),
  reaction: counted('reactions', 'social_reaction'),
  comment: counted('comments', 'social_comment'),
  member_repost: counted('posts', 'social_member_repost'),
  followed_post: counted('posts', 'social_followed_post'),
  booking_open: counted('bookings', 'social_booking_open'),
  event_open: counted('events', 'social_event_open'),
  friend_reaction: counted('posts', 'social_friend_reaction'),
  friend_comment: counted('posts', 'social_friend_comment'),
  // Not counted: addressed to the reader, asked for by them, or the owner's exceptions.
  reply: FREE,
  mention: FREE,
  live_mention: FREE,
  association_post: FREE,
  association_repost: FREE,
  birthday: FREE,
  live_started: FREE,
  form_reminder: FREE,
  follow_request: FREE,
  follow_accepted: FREE,
  booking_cancelled: FREE,
  booking_withdrawn: FREE,
  booking_added: FREE,
  booking_reminder: FREE,
  booking_changed: FREE,
  booking_removed: FREE,
  // Not counted: moderation, the organiser and manager workflow, payments.
  repost_proposed: FREE,
  coorganise_proposed: FREE,
  event_proposed: FREE,
  event_validated: FREE,
  event_rejected: FREE,
  event_updated: FREE,
  event_deleted: FREE,
  event_pending: FREE,
  event_pending_coorganiser: FREE,
  profile_correction_applied: FREE,
  profile_correction_refused: FREE,
  repost_personal_requested: FREE,
  repost_personal_accepted: FREE,
  repost_personal_refused: FREE,
  live_cut: FREE,
  live_suspended: FREE,
  live_withdrawn: FREE,
  form_paid_over_capacity: FREE,
  lydia_payments_active: FREE,
  lydia_payments_paused: FREE,
  lydia_refund_issued: FREE,
  lydia_cashier_added: FREE,
  delegation_revoked: FREE,
  delegation_receiver_not_ready: FREE,
  delegation_resumed: FREE,
};

/**
 * The counted types, read off {@link PUSH_BUDGET} - the cap's allowlist: their content keys, their
 * category, and the FLOOR of their keys (`PUSH_KEY_MIN_CLIENT`; every key of one type shares it, a
 * spec asserts so), which chat-delivery applies AFTER the claim - so the claim applies it first,
 * and a reader with no device able to show the push never spends a unit on it.
 */
export const CAPPED_PUSH_TYPES: ReadonlyMap<
  string,
  { contentKeys: readonly PushContentKey[]; category: string; floor: string | null }
> = new Map(
  Object.entries(PUSH_BUDGET).flatMap(([type, budget]) =>
    budget.counted
      ? [
          [
            type,
            {
              contentKeys: budget.contentKeys,
              category: budget.category,
              floor: PUSH_KEY_MIN_CLIENT[budget.contentKeys[0]] ?? null,
            },
          ] as const,
        ]
      : []
  )
);

/**
 * A device's build as `major.minor.patch`, NULL when it was never reported or does not parse - read
 * exactly as chat-delivery's `appVersionAtLeast` reads it (a suffix after `-` or `+` ignored), so the
 * claim and the send agree on which device is too old. POSIX classes, no backslash: this text sits
 * in a template literal, where a backslash would be eaten.
 */
const DEVICE_CORE_SQL = `substring(kp."deviceAppVersion" from '^[[:space:]]*([0-9]+[.][0-9]+[.][0-9]+)[[:space:]]*([-+].*)?$')`;

/**
 * The one statement of a capped fan-out: for every DISTINCT recipient (a fan-out that names a
 * reader twice would make `ON CONFLICT DO UPDATE` touch one row twice, which PostgreSQL refuses), in
 * ONE lock order (two concurrent fan-outs over overlapping readers can then never deadlock, and the
 * row lock orders them on each shared reader, so the cap is exact), skipping a reader who switched
 * the type's category off (`notification_preference`, chat-delivery's table in the same database:
 * they are never pushed, so they must not spend the budget), and skipping a reader with no device
 * able to show the push - when the type has a floor (`$4`), chat-delivery drops the tokens of
 * devices KNOWN to run an older build (`key_package."deviceAppVersion"`), keeping a device of
 * unknown build, so this asks the same of the same tables before a unit is spent - one unit of
 * today's budget is taken while it lasts. `RETURNING` names the readers who got one - the others
 * keep their bell row only.
 *
 * `$1` the recipients, `$2` the cap, `$3` the category, `$4` the floor (NULL for none).
 */
export const CLAIM_ENGAGEMENT_PUSHES_SQL = `INSERT INTO engagement_push_days ("userId", day, pushed)
SELECT ids.r, (now() AT TIME ZONE 'Europe/Paris')::date, 1
  FROM (SELECT DISTINCT r FROM unnest($1::varchar[]) r) ids
 WHERE NOT EXISTS (SELECT 1 FROM notification_preference np
                    WHERE np."userId" = ids.r AND np."disabledCategories" ? $3::text)
   AND ($4::text IS NULL OR EXISTS (
         SELECT 1 FROM push_token pt
           LEFT JOIN key_package kp ON kp."userId" = pt."userId" AND kp."deviceId" = pt."deviceId"
          WHERE pt."userId" = ids.r
            AND (${DEVICE_CORE_SQL} IS NULL
                 OR string_to_array(${DEVICE_CORE_SQL}, '.')::int[] >= string_to_array($4::text, '.')::int[])))
 ORDER BY ids.r
ON CONFLICT ("userId", day) DO UPDATE SET pushed = engagement_push_days.pushed + 1
  WHERE engagement_push_days.pushed < $2::int
RETURNING "userId"`;

/** Days a `campus_trend_weeks` row is kept after its week ends (register C7, the privacy policy). */
export const CAMPUS_TREND_WEEKS_KEPT = 14;

/**
 * The daily GC's statement, counted: the daily push counters older than
 * {@link ENGAGEMENT_PUSH_DAYS_KEPT} days, and the weekly campus-trend counters (migration 163)
 * {@link CAMPUS_TREND_WEEKS_KEPT} days after their week ENDED (`week` is its Monday, so the week ends
 * on `week + 7`, and the row goes on day `week + 7 + 14`) - the trend's week claim reads only the
 * current week.
 */
export const PRUNE_ENGAGEMENT_PUSH_DAYS_SQL = `WITH gone AS (
  DELETE FROM engagement_push_days
   WHERE day < (now() AT TIME ZONE 'Europe/Paris')::date - ${ENGAGEMENT_PUSH_DAYS_KEPT}
  RETURNING 1),
gone_weeks AS (
  DELETE FROM campus_trend_weeks
   WHERE week + 7 <= (now() AT TIME ZONE 'Europe/Paris')::date - ${CAMPUS_TREND_WEEKS_KEPT}
  RETURNING 1)
SELECT ((SELECT count(*) FROM gone) + (SELECT count(*) FROM gone_weeks))::int AS n`;

/** Deletes the counter rows the cap and the trend's week claim no longer read; answers how many. */
export async function pruneEngagementPushDays(
  manager: Pick<EntityManager, 'query'>
): Promise<number> {
  const rows: { n: number }[] = await manager.query(PRUNE_ENGAGEMENT_PUSH_DAYS_SQL);
  return rows[0]?.n ?? 0;
}

/**
 * Takes one unit of today's budget for each of `recipients` who still has one, has not switched
 * `category` off and has a device able to show a push of `floor`; answers who may be pushed. One
 * statement, whatever the fan-out's size.
 */
export async function claimEngagementPushes(
  manager: Pick<EntityManager, 'query'>,
  recipients: readonly string[],
  category: string,
  floor: string | null = null
): Promise<Set<string>> {
  if (recipients.length === 0) return new Set();
  const rows: { userId: string }[] = await manager.query(CLAIM_ENGAGEMENT_PUSHES_SQL, [
    recipients,
    ENGAGEMENT_DAILY_PUSH_CAP,
    category,
    floor,
  ]);
  return new Set(rows.map((r) => r.userId));
}
