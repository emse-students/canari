import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { previewOf } from '../push/push-content';
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
 * integer at which at most one post per campus per day would have crossed over the last 90 days -
 * R1, read on production 2026-11-09: Saint-Etienne 1.18 posts a day at 3, at most 1.00 at 4;
 * Gardanne none at any threshold (docs/wiki/engagement.md, "R1 - the trend threshold"). A
 * MEASUREMENT, re-derived from the same query if the population changes.
 */
export const TREND_THRESHOLD = 4;

/** How long after its `publishedAt` a post may still take off: the rule's "a short time". */
export const TREND_WINDOW_HOURS = 24;

/**
 * THE CROSSING, STAMPED ONCE (`$1` the post): the one statement that answers "did THIS write make
 * the post take off". The stamp is the idempotence - `WHERE "trendAnnouncedAt" IS NULL`, so of two
 * concurrent writes the row lock lets exactly one through and the other re-reads a stamped row (the
 * `lives."announcedAt"` pattern); the 24-hour bound decides eligibility only, read from the
 * database's clock. Only a published post, not hidden, not a reel (CanaReels is its own viewer).
 */
export const STAMP_TREND_SQL = `UPDATE posts SET "trendAnnouncedAt" = now()
 WHERE id = $1::uuid
   AND "trendAnnouncedAt" IS NULL
   AND kind = 'post'
   AND NOT COALESCE("hiddenByModeration", false)
   AND ("scheduledAt" IS NULL OR "scheduledAt" <= now())
   AND "publishedAt" > now() - make_interval(hours => ${TREND_WINDOW_HOURS})
   AND ${engagedAccountsSql('posts')} >= ${TREND_THRESHOLD}
RETURNING id, markdown`;

/**
 * WHO IS TOLD (the post of the `stamped` CTE, {@link campusTrendSql}), into the told-once ledger: everyone who sees the post
 * through the SPACE rule - it reaches one of their spaces (`postReachesSpaceSql`) and the plain
 * predicate holds with the follower door CLOSED and no read grant ("from your space", decision 5c) -
 * minus its author, a block either way with the author when the post NAMES it (an anonymous or an
 * association post is exempt, as in the feed - `namedAuthorUnblockedSql`), the other side of the review cohort, and
 * whoever already has a row for it in the ledger or in `post_notifications` (L14). Built per call:
 * the cohort is read from the environment.
 */
export function campusTrendLedgerSql(): string {
  return `INSERT INTO post_engagement_notices ("postId", "recipientId", reason)
SELECT ct_post.id, ct_user.id, 'trend'
  FROM stamped ct_s
  JOIN posts ct_post ON ct_post.id = ct_s.id
  JOIN users ct_user ON ct_user.id <> ct_post."authorId"
 WHERE ${sameSideOfReviewCohortSql('ct_user.id', 'ct_post."authorId"')}
   AND ${namedAuthorUnblockedSql('ct_post', 'ct_user.id')}
   AND EXISTS (SELECT 1 FROM spaces ct_space
                WHERE ${isReaderSpaceSql('ct_space', 'ct_user')} AND ${postReachesSpaceSql('ct_post', 'ct_space')})
   AND ${postVisibleToUserSql('ct_post', 'ct_user', { followers: false })}
   AND NOT EXISTS (SELECT 1 FROM post_notifications ct_n
                    WHERE ct_n."postId" = ct_post.id::text AND ct_n."recipientId" = ct_user.id)
 ORDER BY ct_user.id
ON CONFLICT DO NOTHING
RETURNING "recipientId"`;
}

/**
 * THE STAMP AND ITS LEDGER IN ONE STATEMENT (`$1` the post): {@link STAMP_TREND_SQL} as a
 * data-modifying CTE that {@link campusTrendLedgerSql} reads, so the stamp that says "this post was
 * announced" and the rows that say "these readers were told" commit together or not at all - a
 * failure between two statements would leave a stamped post that nobody was told of, for ever.
 * Answers the stamped post's text (none when this write did not cross) and the readers told.
 */
export function campusTrendSql(): string {
  return `WITH stamped AS (${STAMP_TREND_SQL}),
told AS (${campusTrendLedgerSql()})
SELECT ct_s.markdown,
       ARRAY(SELECT "recipientId" FROM told ORDER BY 1) AS told
  FROM stamped ct_s`;
}

/**
 * After a reaction or a comment on post `postId` is stored: if THIS write made the post take off,
 * stamps it and tells its space - the ledger first, then one in-app row and one push per reader the
 * ledger took, through `createNotifications` (the daily cap applies, WP-8). Answers how many were
 * told; 0 when the post did not cross here (below the threshold, past 24 hours, or already stamped).
 *
 * Nobody acted in the notice's name: the row and the push carry the system actor, never the
 * author - an anonymous post stays anonymous, and a trend is the campus's, not a person's.
 */
export async function announceCampusTrend(
  deps: {
    manager: Pick<EntityManager, 'query'>;
    notifications: Pick<PostNotificationsService, 'createNotifications'>;
  },
  postId: string
): Promise<number> {
  const [stamped]: { markdown: string | null; told: string[] }[] = await deps.manager.query(
    campusTrendSql(),
    [postId]
  );
  if (!stamped) return 0;
  const told = stamped.told ?? [];
  logger.log(`[TREND] post=${postId.slice(0, 8)} took off: ${told.length} to tell`);
  if (told.length === 0) return 0;
  await deps.notifications.createNotifications({
    recipientIds: told,
    type: CAMPUS_TREND_NOTIFICATION,
    postId,
    actorId: SYSTEM_ACTOR_ID,
    actorName: '',
    text: previewOf(stamped.markdown ?? ''),
  });
  return told.length;
}
