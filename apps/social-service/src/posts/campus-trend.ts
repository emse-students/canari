import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { acceptedFollowSql } from '../follows/follow-status';
import { previewOf, type TrendLikedBy, type TrendMedia } from '../push/push-content';
import { formatUserDisplayNameFromRaw } from '../utils/user-display-name';
import {
  commentsWithheldFromViewerSql,
  isReaderSpaceSql,
  postReachesSpaceSql,
  postVisibleToUserSql,
  sameSideOfReviewCohortSql,
} from '../spaces/reader-spaces';
import { engagedAccountsSql } from './engagement-sql';
import { CAMPUS_TREND_NOTIFICATION } from './engagement-push-cap';
import type { PostNotificationsService } from './post-notifications.service';
import { SYSTEM_ACTOR_ID } from './post-notifications.service';

const logger = new Logger('CampusTrend');

/**
 * A SQL boolean: no block either way between reader `reader` and the author of post row `post` -
 * ASKED ONLY OF A POST THAT NAMES ITS AUTHOR. An association post hides the member who published it
 * and an anonymous one its writer, so the feed exempts both from its block filter
 * (`blockedAuthorSql`, `common/blocked-user-ids.ts`); a notice withheld on that block would be the
 * de-anonymisation oracle the feed refuses to be - block a suspect, see whether the notice about
 * the anonymous post still comes. Asked by campus trends (WP-10); friends' activity asked it too until it stopped notifying (owner, 2026-11-10).
 */
export function namedAuthorUnblockedSql(post: string, reader: string): string {
  return `(${post}."associationId" IS NOT NULL OR COALESCE(${post}.anonymous, false)
     OR NOT EXISTS (SELECT 1 FROM user_blocks nau_b
                     WHERE (nau_b."blockerId" = ${reader} AND nau_b."blockedId" = ${post}."authorId")
                        OR (nau_b."blockedId" = ${reader} AND nau_b."blockerId" = ${post}."authorId")))`;
}

/**
 * HOW MANY DISTINCT ACCOUNTS make a post take off (engagement WP-10, decision 5c): the smallest
 * integer at which the posts crossing over 90 days are at most one per three days per campus - R1
 * (docs/wiki/engagement.md, "R1 - the trend threshold"), read per day on production 2026-11-10
 * (Saint-Etienne: 28 posts in 90 days at 10, 37 at 8). A burst day can still carry several crossings
 * (up to 10 at this value); the per-reader daily rule (`trendDay`, migration 161) absorbs it, so no
 * reader hears of more than one. THIS IS THE ONE PLACE the number is written: one edit changes it,
 * and a change never announces a post already past it (the crossing rule below). Lead's decision of
 * 2026-11-10; 4 before it.
 */
export const TREND_THRESHOLD = 10;

/**
 * HOW MANY TRENDS ONE READER IS TOLD OF PER WEEK (owner, 2026-11-10: "on y est allés un peu fort"),
 * on top of one per day: a Monday-to-Sunday week on the Paris calendar, read from the ledger's own
 * `"trendDay"` rows - durable state, no clock heuristic.
 */
export const TREND_WEEKLY_CAP = 2;

/** How long after its `publishedAt` a post may still take off: the rule's "a short time". */
export const TREND_WINDOW_HOURS = 24;

/** The Paris calendar date read from the DATABASE, the day of the one-trend-a-day rule (L6's day). */
const PARIS_DAY_SQL = `(now() AT TIME ZONE 'Europe/Paris')::date`;

/**
 * THE EVALUATION (`$1` the post): the one statement that answers "did THIS write make the post take
 * off". Two answers, kept apart since the review of #3312:
 *
 * - THE STAMP (`"trendAnnouncedAt"`) is written at the first evaluation that finds the engaged count
 *   AT OR ABOVE {@link TREND_THRESHOLD} - a level, whatever came before, a hidden post included. A
 *   stamped post is never evaluated again, so the stamp means "this post is past the threshold and
 *   will never be announced from now on".
 * - THE ANNOUNCEMENT (`crossed`) is made only when that stamp is a CROSSING OBSERVED: the count
 *   RECORDED by the previous evaluation (`"trendEngagedSeen"`, migration 161, read as `old.` - the row
 *   version this UPDATE replaced, under its lock) was BELOW the threshold, and the post is not hidden.
 *   A post is born with 0 (the column's default: nobody has engaged with a post being inserted).
 *
 * WHY (2026-11-10). The first version announced on a level: when `1.6.9` deployed, every post of the
 * previous 24 hours already past 4 took off at its next reaction - five posts in eight minutes, 2483
 * notifications. Now:
 * - a post that existed before the rule has NO recorded count (`NULL`): its first evaluation records
 *   one, and if it is already past the threshold it is STAMPED SILENTLY - so a deploy announces no
 *   backlog, ever, and a later rollback to `1.6.9` (which announces on a level any unstamped post)
 *   finds it stamped (the rest: the pre-rollback statement in docs/wiki/engagement.md);
 * - a HIDDEN post past the threshold is stamped silently too, so a moderator's restore cannot announce
 *   it on a level read: what took off while nobody could see it is not news;
 * - a CHANGE of the threshold announces nothing: an unstamped post's recorded count is below the old
 *   threshold; lowered to `t`, a post recorded at or above `t` is stamped silently at its next write;
 * - concurrent writes cannot hide a crossing: the row lock orders them, `old.` is the version each one
 *   replaced, and `WHERE "trendAnnouncedAt" IS NULL` lets exactly one stamp through (the
 *   `lives."announcedAt"` pattern).
 *
 * The 24-hour bound decides eligibility only, read from the database's clock. Only a published post,
 * not a reel (CanaReels is its own viewer). A write that changes no count updates nothing.
 *
 * Answers one row per evaluated post: `crossed` says whether THIS evaluation announces it.
 */
export const EVALUATE_TREND_SQL = `UPDATE posts SET
       "trendEngagedSeen" = ${engagedAccountsSql('posts')},
       "trendAnnouncedAt" = CASE WHEN ${engagedAccountsSql('posts')} >= ${TREND_THRESHOLD}
                             THEN now() END
 WHERE id = $1::uuid
   AND "trendAnnouncedAt" IS NULL
   AND kind = 'post'
   AND ("scheduledAt" IS NULL OR "scheduledAt" <= now())
   AND "publishedAt" > now() - make_interval(hours => ${TREND_WINDOW_HOURS})
   AND "trendEngagedSeen" IS DISTINCT FROM ${engagedAccountsSql('posts')}
RETURNING id, markdown, images,
          COALESCE(new."trendAnnouncedAt" IS NOT NULL
                   AND old."trendEngagedSeen" < ${TREND_THRESHOLD}
                   AND NOT COALESCE(new."hiddenByModeration", false), false) AS crossed,
          new."trendAnnouncedAt" IS NOT NULL AS stamped`;

/**
 * WHO MAY BE TOLD (the post of the `stamped` CTE, {@link campusTrendSql}): everyone who sees the post
 * through the SPACE rule - it reaches one of their spaces (`postReachesSpaceSql`) and the plain
 * predicate holds with the follower door CLOSED and no read grant ("from your space", decision 5c) -
 * minus its author, a block either way with the author when the post NAMES it (an anonymous or an
 * association post is exempt, as in the feed - `namedAuthorUnblockedSql`), the other side of the
 * review cohort, and whoever already has a row for it in the ledger or in `post_notifications` (L14).
 * Built per call: the cohort is read from the environment.
 */
export function campusTrendCandidatesSql(): string {
  return `SELECT ct_post.id AS "postId", ct_user.id AS "recipientId"
  FROM stamped ct_s
  JOIN posts ct_post ON ct_post.id = ct_s.id
  JOIN users ct_user ON ct_user.id <> ct_post."authorId"
 WHERE ${sameSideOfReviewCohortSql('ct_user.id', 'ct_post."authorId"')}
   AND ${namedAuthorUnblockedSql('ct_post', 'ct_user.id')}
   AND EXISTS (SELECT 1 FROM spaces ct_space
                WHERE ${isReaderSpaceSql('ct_space', 'ct_user')} AND ${postReachesSpaceSql('ct_post', 'ct_space')})
   AND ${postVisibleToUserSql('ct_post', 'ct_user', { followers: false })}
   AND NOT EXISTS (SELECT 1 FROM post_engagement_notices ct_e
                    WHERE ct_e."postId" = ct_post.id AND ct_e."recipientId" = ct_user.id)
   AND NOT EXISTS (SELECT 1 FROM post_notifications ct_n
                    WHERE ct_n."postId" = ct_post.id::text AND ct_n."recipientId" = ct_user.id)`;
}

/**
 * WHO IS TOLD, into the told-once ledger: every candidate, ONE TREND PER READER PER PARIS DAY AND
 * {@link TREND_WEEKLY_CAP} PER PARIS WEEK (owner, 2026-11-10). The row carries its day
 * (`"trendDay"`), and a partial UNIQUE index on (reader, day) (migration 161) makes a second trend
 * the same day a conflict - `ON CONFLICT DO NOTHING` with no target answers every unique
 * constraint, the told-once primary key and that index alike. So the ledger IS the counter: one row
 * is both "told of this post" and "told today", written in one statement, and two posts crossing at
 * the same instant are ordered by the index, never by a clock.
 *
 * THE WEEK is counted from the same rows: a reader with {@link TREND_WEEKLY_CAP} rows on EARLIER days
 * of this Monday-to-Sunday Paris week is not a candidate. Only earlier days are counted, and that is
 * what makes the bound exact under concurrency: a row of an earlier day can no longer be written (it
 * is a past date), so every concurrent writer reads the same count; today's single row is the
 * index's. A new week is a new range of dates - nothing resets anything.
 */
export function campusTrendLedgerSql(): string {
  return `INSERT INTO post_engagement_notices ("postId", "recipientId", reason, "trendDay")
SELECT ct_c."postId", ct_c."recipientId", 'trend', ${PARIS_DAY_SQL}
  FROM candidates ct_c
 WHERE (SELECT count(*) FROM post_engagement_notices ct_w
         WHERE ct_w."recipientId" = ct_c."recipientId"
           AND ct_w."trendDay" >= date_trunc('week', ${PARIS_DAY_SQL})::date
           AND ct_w."trendDay" < ${PARIS_DAY_SQL}) < ${TREND_WEEKLY_CAP}
 ORDER BY ct_c."recipientId"
ON CONFLICT DO NOTHING
RETURNING "recipientId"`;
}

/**
 * WHOM EACH TOLD READER SEES LIKING THE POST (owner, 2026-11-10: friends' activity is no longer a
 * notification - the trend names the followed people who reacted instead): for each reader the
 * ledger took, ONE account they follow (accepted) that reacted to the post, the smallest id of them
 * (deterministic), under the disclosure rule friends' activity had - the account shares its activity
 * (no `user_activity_settings` row saying otherwise), is not the post's author, has no block either
 * way with the reader, stands on the reader's side of the review cohort, and the post's reactors are
 * not withheld from the reader. NULL when no such account exists: the trend then names nobody.
 * Reactions only - the sentence is "aimée par". Read from the `told` and `stamped` CTEs.
 */
export function campusTrendNamedSql(): string {
  return `SELECT ct_t."recipientId",
       (SELECT min(ct_f."followedUserId") FROM user_follows ct_f
         WHERE ct_f."followerUserId" = ct_t."recipientId" AND ${acceptedFollowSql('ct_f')}
           AND ct_np.reactions ? ct_f."followedUserId"
           AND ct_f."followedUserId" <> ct_np."authorId"
           AND NOT EXISTS (SELECT 1 FROM user_activity_settings ct_set
                            WHERE ct_set."userId" = ct_f."followedUserId" AND NOT ct_set."shareActivity")
           AND NOT EXISTS (SELECT 1 FROM user_blocks ct_b
                            WHERE (ct_b."blockerId" = ct_t."recipientId" AND ct_b."blockedId" = ct_f."followedUserId")
                               OR (ct_b."blockedId" = ct_t."recipientId" AND ct_b."blockerId" = ct_f."followedUserId"))
           AND ${sameSideOfReviewCohortSql('ct_t."recipientId"', 'ct_f."followedUserId"')}
           AND NOT ${commentsWithheldFromViewerSql('ct_np', 'ct_t."recipientId"')}) AS friend
  FROM told ct_t
  JOIN stamped ct_s ON true
  JOIN posts ct_np ON ct_np.id = ct_s.id`;
}

/**
 * THE EVALUATION, THE STAMP AND ITS LEDGER IN ONE STATEMENT (`$1` the post):
 * {@link EVALUATE_TREND_SQL} as a data-modifying CTE that {@link campusTrendLedgerSql} reads, so the
 * stamp that says "this post was announced" and the rows that say "these readers were told" commit
 * together or not at all - a failure between two statements would leave a stamped post that nobody
 * was told of, for ever. Answers ONE row: whether this write announced the post (`announced`, then
 * its text and media), whether it stamped it WITHOUT an announcement (`silent`: past the threshold
 * with no crossing seen), how many readers were eligible, and the readers told.
 */
export function campusTrendSql(): string {
  return `WITH evaluated AS (${EVALUATE_TREND_SQL}),
stamped AS (SELECT id, markdown, images FROM evaluated WHERE crossed),
candidates AS (${campusTrendCandidatesSql()}),
told AS (${campusTrendLedgerSql()}),
named AS (${campusTrendNamedSql()})
SELECT EXISTS (SELECT 1 FROM stamped) AS announced,
       EXISTS (SELECT 1 FROM evaluated WHERE stamped AND NOT crossed) AS silent,
       (SELECT markdown FROM stamped) AS markdown,
       (SELECT images FROM stamped) AS images,
       (SELECT count(*) FROM candidates)::int AS eligible,
       (SELECT count(*) FROM stamped ct_s JOIN posts ct_rp ON ct_rp.id = ct_s.id,
               jsonb_object_keys(ct_rp.reactions) ct_k
         WHERE ct_k <> ct_rp."authorId")::int AS reactors,
       COALESCE((SELECT json_agg(json_build_object(
                   'recipientId', ct_n."recipientId",
                   'friendId', ct_n.friend,
                   'displayName', ct_u."displayName",
                   'firstName', ct_u."firstName",
                   'lastName', ct_u."lastName") ORDER BY ct_n."recipientId")
                   FROM named ct_n LEFT JOIN users ct_u ON ct_u.id = ct_n.friend), '[]'::json) AS told`;
}

/**
 * What names a post with no text in a trend: its FIRST picture or video (`posts.images`, the media
 * refs in their order), or `null` when it has neither - a poll, a file, a voice note.
 */
export function trendMediaOf(images: unknown): TrendMedia {
  if (!Array.isArray(images)) return null;
  for (const ref of images as unknown[]) {
    const type = (ref as { type?: unknown } | null)?.type;
    if (type === 'image') return 'photo';
    if (type === 'video') return 'video';
  }
  return null;
}

/**
 * After a reaction or a comment on post `postId` is stored: if THIS write made the post take off,
 * stamps it and tells its space - the ledger first, then one in-app row and one push per reader the
 * ledger took, through `createNotifications` (the daily cap applies, WP-8). Answers how many were
 * told; 0 when the post did not cross here (below the threshold, past 24 hours, already stamped, or
 * past the threshold before any evaluation saw it below).
 *
 * Nobody acted in the notice's name: the row and the push carry the system actor, never the
 * author - an anonymous post stays anonymous, and a trend is the campus's, not a person's. The row's
 * `meta.media` says what the post shows when it has no text, so the bell can say "une photo".
 */
export async function announceCampusTrend(
  deps: {
    manager: Pick<EntityManager, 'query'>;
    notifications: Pick<PostNotificationsService, 'createNotifications'>;
  },
  postId: string
): Promise<number> {
  const [result]: {
    announced: boolean;
    silent: boolean;
    markdown: string | null;
    images: unknown;
    eligible: number;
    reactors: number;
    told: TrendToldRow[];
  }[] = await deps.manager.query(campusTrendSql(), [postId]);
  if (result?.silent) {
    // Past the threshold without a crossing anybody saw: a post older than the rule, a hidden one,
    // or a lowered threshold. Stamped, so never announced - said once, at the stamp.
    logger.log(
      `[TREND] post=${postId.slice(0, 8)} stamped without an announcement (no crossing seen)`
    );
  }
  if (!result?.announced) return 0;
  const told = result.told ?? [];
  const media = trendMediaOf(result.images);
  const groups = groupByLikedBy(told, result.reactors);
  logger.log(
    `[TREND] post=${postId.slice(0, 8)} took off: ${told.length} to tell of ${result.eligible} ` +
      `eligible (${result.eligible - told.length} already told of a trend today, twice this week, ` +
      `or concurrently) media=${media ?? 'none'} named=${told.length - (groups.get(NOBODY)?.recipients.length ?? 0)}`
  );
  if (told.length === 0) return 0;
  const text = previewOf(result.markdown ?? '');
  // ONE SEND PER NAMED ACCOUNT: the row and the push differ only by who is named, so the readers
  // who see the same friend share one batch (one insert, one bounded fan-out).
  for (const { likedBy, recipients } of groups.values()) {
    const meta = {
      ...(media ? { media } : {}),
      ...(likedBy ? { likedBy } : {}),
    };
    await deps.notifications.createNotifications({
      recipientIds: recipients,
      type: CAMPUS_TREND_NOTIFICATION,
      postId,
      actorId: SYSTEM_ACTOR_ID,
      actorName: '',
      text,
      ...(Object.keys(meta).length ? { meta } : {}),
    });
  }
  return told.length;
}

/** One reader the ledger took, with the followed account the trend names for them (or none). */
type TrendToldRow = {
  recipientId: string;
  friendId: string | null;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
};

/** The group key of the readers the trend names nobody to. */
const NOBODY = '';

/**
 * The told readers grouped by the account the trend names for them. `others` is every OTHER account
 * that reacted (the post's reactors minus the author and the named one). An account with no name to
 * show is not named - a trend never prints an id.
 */
export function groupByLikedBy(
  told: readonly TrendToldRow[],
  reactors: number
): Map<string, { likedBy: TrendLikedBy; recipients: string[] }> {
  const groups = new Map<string, { likedBy: TrendLikedBy; recipients: string[] }>();
  for (const row of told) {
    const name = row.friendId ? formatUserDisplayNameFromRaw(row) : '';
    const key = name ? row.friendId! : NOBODY;
    let group = groups.get(key);
    if (!group) {
      group = {
        likedBy: name ? { name, others: Math.max(0, reactors - 1) } : null,
        recipients: [],
      };
      groups.set(key, group);
    }
    group.recipients.push(row.recipientId);
  }
  return groups;
}
