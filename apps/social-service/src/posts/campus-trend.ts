import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { previewOf, type TrendMedia } from '../push/push-content';
import {
  isReaderSpaceSql,
  postReachesSpaceSql,
  postVisibleToUserSql,
  sameSideOfReviewCohortSql,
} from '../spaces/reader-spaces';
import { engagedAccountsSql } from './engagement-sql';
import { CAMPUS_TREND_NOTIFICATION } from './engagement-push-cap';
import { namedAuthorUnblockedSql } from './friend-activity';
import type { PostNotificationsService } from './post-notifications.service';
import { SYSTEM_ACTOR_ID } from './post-notifications.service';

const logger = new Logger('CampusTrend');

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

/** How long after its `publishedAt` a post may still take off: the rule's "a short time". */
export const TREND_WINDOW_HOURS = 24;

/** The Paris calendar date read from the DATABASE, the day of the one-trend-a-day rule (L6's day). */
const PARIS_DAY_SQL = `(now() AT TIME ZONE 'Europe/Paris')::date`;

/**
 * THE CROSSING, STAMPED ONCE (`$1` the post): the one statement that answers "did THIS write make
 * the post take off". A post takes off at the evaluation that finds its engaged count AT OR ABOVE
 * {@link TREND_THRESHOLD} when the count RECORDED ON THE POST by the previous evaluation
 * (`"trendEngagedSeen"`, migration 161) was BELOW it - a crossing observed, never a level read. Every
 * evaluation records the count it read, and a post is born with 0 (the column's default: no account
 * has engaged with a post that is being inserted).
 *
 * WHY A CROSSING AND NOT A LEVEL (2026-11-10). The first version stamped any post AT OR ABOVE the
 * threshold. When `1.6.9` deployed, every post of the previous 24 hours already past 4 took off at
 * its next reaction - five posts in eight minutes, 2483 notifications. With the recorded count:
 * - a post that existed before the rule has NO recorded count (`NULL`): its first evaluation records
 *   one and stamps nothing (`NULL < T` is not true), so a deploy announces no backlog, ever;
 * - a CHANGE of the threshold announces nothing either: a post recorded at 9 that reads 10 after the
 *   constant moved from 10 to 9 has crossed nothing under the new rule (`9 < 9` is false);
 * - concurrent writes cannot hide a crossing: the count is re-read under the row lock, so whichever
 *   evaluation runs first after the count passed the threshold finds the last recorded one below it.
 *
 * The stamp is still the idempotence - `WHERE "trendAnnouncedAt" IS NULL`, so of two concurrent
 * writes the row lock lets exactly one through (the `lives."announcedAt"` pattern); the 24-hour bound
 * decides eligibility only, read from the database's clock. Only a published post, not hidden, not a
 * reel (CanaReels is its own viewer). A write that changes no count updates nothing.
 *
 * Answers one row per evaluated post: `crossed` says whether THIS evaluation stamped it.
 */
export const EVALUATE_TREND_SQL = `UPDATE posts SET
       "trendEngagedSeen" = ${engagedAccountsSql('posts')},
       "trendAnnouncedAt" = CASE WHEN "trendEngagedSeen" < ${TREND_THRESHOLD}
                                  AND ${engagedAccountsSql('posts')} >= ${TREND_THRESHOLD}
                             THEN now() END
 WHERE id = $1::uuid
   AND "trendAnnouncedAt" IS NULL
   AND kind = 'post'
   AND NOT COALESCE("hiddenByModeration", false)
   AND ("scheduledAt" IS NULL OR "scheduledAt" <= now())
   AND "publishedAt" > now() - make_interval(hours => ${TREND_WINDOW_HOURS})
   AND "trendEngagedSeen" IS DISTINCT FROM ${engagedAccountsSql('posts')}
RETURNING id, markdown, images, "trendAnnouncedAt" IS NOT NULL AS crossed`;

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
 * WHO IS TOLD, into the told-once ledger: every candidate, ONE TREND PER READER PER PARIS DAY (owner,
 * 2026-11-10). The row carries its day (`"trendDay"`), and a partial UNIQUE index on (reader, day)
 * (migration 161) makes a second trend the same day a conflict - `ON CONFLICT DO NOTHING` with no
 * target answers every unique constraint, the told-once primary key and that index alike. So the
 * ledger IS the daily counter: one row is both "told of this post" and "told today", written in one
 * statement, and two posts crossing at the same instant are ordered by the index, never by a clock.
 * A reader told of a trend today is told of no other until the next day - the first one wins.
 */
export function campusTrendLedgerSql(): string {
  return `INSERT INTO post_engagement_notices ("postId", "recipientId", reason, "trendDay")
SELECT ct_c."postId", ct_c."recipientId", 'trend', ${PARIS_DAY_SQL}
  FROM candidates ct_c
 ORDER BY ct_c."recipientId"
ON CONFLICT DO NOTHING
RETURNING "recipientId"`;
}

/**
 * THE EVALUATION, THE STAMP AND ITS LEDGER IN ONE STATEMENT (`$1` the post):
 * {@link EVALUATE_TREND_SQL} as a data-modifying CTE that {@link campusTrendLedgerSql} reads, so the
 * stamp that says "this post was announced" and the rows that say "these readers were told" commit
 * together or not at all - a failure between two statements would leave a stamped post that nobody
 * was told of, for ever. Answers the stamped post's text and media (no row when this write did not
 * cross), how many readers were eligible, and the readers told.
 */
export function campusTrendSql(): string {
  return `WITH evaluated AS (${EVALUATE_TREND_SQL}),
stamped AS (SELECT id, markdown, images FROM evaluated WHERE crossed),
candidates AS (${campusTrendCandidatesSql()}),
told AS (${campusTrendLedgerSql()})
SELECT ct_s.markdown, ct_s.images,
       (SELECT count(*) FROM candidates)::int AS eligible,
       ARRAY(SELECT "recipientId" FROM told ORDER BY 1) AS told
  FROM stamped ct_s`;
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
  const [stamped]: {
    markdown: string | null;
    images: unknown;
    eligible: number;
    told: string[];
  }[] = await deps.manager.query(campusTrendSql(), [postId]);
  if (!stamped) return 0;
  const told = stamped.told ?? [];
  const media = trendMediaOf(stamped.images);
  logger.log(
    `[TREND] post=${postId.slice(0, 8)} took off: ${told.length} to tell of ${stamped.eligible} ` +
      `eligible (${stamped.eligible - told.length} already told of a trend today or concurrently) media=${media ?? 'none'}`
  );
  if (told.length === 0) return 0;
  await deps.notifications.createNotifications({
    recipientIds: told,
    type: CAMPUS_TREND_NOTIFICATION,
    postId,
    actorId: SYSTEM_ACTOR_ID,
    actorName: '',
    text: previewOf(stamped.markdown ?? ''),
    ...(media ? { meta: { media } } : {}),
  });
  return told.length;
}
