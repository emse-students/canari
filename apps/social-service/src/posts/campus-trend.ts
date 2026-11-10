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
import { engagedAccountsSql, TREND_LIKES_SQL as LIKES_SQL } from './engagement-sql';
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
 * on top of one per day: a Monday-to-Sunday week on the Paris calendar, counted in the reader's
 * `campus_trend_weeks` row (migration 163) - durable state, no clock heuristic.
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
 * THE READERS WHOSE DAY AND WEEK STILL HAVE ROOM, claimed (owner, 2026-11-10): ONE TREND PER READER
 * PER PARIS DAY AND {@link TREND_WEEKLY_CAP} PER PARIS WEEK, both read from the reader's
 * `campus_trend_weeks` row (migration 163) under its own row lock - `told` the week's count,
 * `"lastDay"` the day of its latest trend. The upsert takes the row only while both hold, so two
 * posts crossing at once for one reader are ordered by the lock and the second finds no room; the
 * bound is exact. The row names no post, so deleting a post frees nothing. One lock order
 * (`ORDER BY`), as the daily push cap's.
 *
 * A reader the ledger already shows told of a trend TODAY is skipped first: the rows a build before
 * migration 163 wrote on its deploy day, which its counter row does not know of.
 */
export function campusTrendWeekClaimSql(): string {
  return `INSERT INTO campus_trend_weeks ("userId", week, told, "lastDay")
SELECT ct_c."recipientId", date_trunc('week', ${PARIS_DAY_SQL})::date, 1, ${PARIS_DAY_SQL}
  FROM candidates ct_c
 WHERE NOT EXISTS (SELECT 1 FROM post_engagement_notices ct_d
                    WHERE ct_d."recipientId" = ct_c."recipientId" AND ct_d."trendDay" = ${PARIS_DAY_SQL})
 ORDER BY ct_c."recipientId"
ON CONFLICT ("userId", week) DO UPDATE
   SET told = campus_trend_weeks.told + 1, "lastDay" = EXCLUDED."lastDay"
 WHERE campus_trend_weeks.told < ${TREND_WEEKLY_CAP}
   AND campus_trend_weeks."lastDay" < EXCLUDED."lastDay"
RETURNING "userId"`;
}

/**
 * WHO IS TOLD, into the told-once ledger: every candidate the week claim took
 * ({@link campusTrendWeekClaimSql}), with its Paris day (`"trendDay"`). `ON CONFLICT DO NOTHING`
 * keeps the told-once primary key and migration 161's (reader, day) index as backstops; the claim
 * already decided who has room.
 */
export function campusTrendLedgerSql(): string {
  return `INSERT INTO post_engagement_notices ("postId", "recipientId", reason, "trendDay")
SELECT ct_c."postId", ct_c."recipientId", 'trend', ${PARIS_DAY_SQL}
  FROM candidates ct_c
  JOIN week_claim ct_w ON ct_w."userId" = ct_c."recipientId"
 ORDER BY ct_c."recipientId"
ON CONFLICT DO NOTHING
RETURNING "recipientId"`;
}

/**
 * WHOM EACH TOLD READER SEES LIKING THE POST (owner, 2026-11-10: friends' activity is no longer a
 * notification - the trend names the followed people who liked it instead): for each reader the
 * ledger took, ONE account they follow (accepted) that LIKED the post ({@link TREND_LIKE_REACTIONS}),
 * the smallest id of them (deterministic), under the disclosure rule friends' activity had - the
 * account shares its activity (no `user_activity_settings` row saying otherwise), is not the post's
 * author (an anonymous author included: the guard is on the id, whatever the post shows), has no
 * block either way with the reader, stands on the reader's side of the review cohort, and the post's
 * reactors are not withheld from the reader. NULL when no such account exists: the trend then names
 * nobody. `others` is how many OTHER accounts liked it - never the author, the named account or the
 * reader themself. Read from the `told` and `stamped` CTEs.
 */
export function campusTrendNamedSql(): string {
  return `SELECT ct_t."recipientId", ct_fr.friend,
       CASE WHEN ct_fr.friend IS NULL THEN 0
            ELSE (SELECT count(*) FROM jsonb_each_text(ct_np.reactions) ct_l
                   WHERE ct_l.value IN (${LIKES_SQL})
                     AND ct_l.key NOT IN (ct_np."authorId", ct_t."recipientId", ct_fr.friend))::int
       END AS others
  FROM told ct_t
  JOIN stamped ct_s ON true
  JOIN posts ct_np ON ct_np.id = ct_s.id
  LEFT JOIN LATERAL (
    SELECT min(ct_f."followedUserId") AS friend FROM user_follows ct_f
     WHERE ct_f."followerUserId" = ct_t."recipientId" AND ${acceptedFollowSql('ct_f')}
       AND ct_np.reactions ->> ct_f."followedUserId" IN (${LIKES_SQL})
       AND ct_f."followedUserId" <> ct_np."authorId"
       AND NOT EXISTS (SELECT 1 FROM user_activity_settings ct_set
                        WHERE ct_set."userId" = ct_f."followedUserId" AND NOT ct_set."shareActivity")
       AND NOT EXISTS (SELECT 1 FROM user_blocks ct_b
                        WHERE (ct_b."blockerId" = ct_t."recipientId" AND ct_b."blockedId" = ct_f."followedUserId")
                           OR (ct_b."blockedId" = ct_t."recipientId" AND ct_b."blockerId" = ct_f."followedUserId"))
       AND ${sameSideOfReviewCohortSql('ct_t."recipientId"', 'ct_f."followedUserId"')}
       AND NOT ${commentsWithheldFromViewerSql('ct_np', 'ct_t."recipientId"')}) ct_fr ON true`;
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
week_claim AS (${campusTrendWeekClaimSql()}),
told AS (${campusTrendLedgerSql()}),
named AS (${campusTrendNamedSql()})
SELECT EXISTS (SELECT 1 FROM stamped) AS announced,
       EXISTS (SELECT 1 FROM evaluated WHERE stamped AND NOT crossed) AS silent,
       (SELECT markdown FROM stamped) AS markdown,
       (SELECT images FROM stamped) AS images,
       (SELECT count(*) FROM candidates)::int AS eligible,
       COALESCE((SELECT json_agg(json_build_object(
                   'recipientId', ct_n."recipientId",
                   'friendId', ct_n.friend,
                   'others', ct_n.others,
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
 * stamps it and tells its space - the week claim and the ledger first (one statement), then EVERY
 * reader's bell row in ONE insert, then one push per group of readers who see the same account
 * named (the daily cap applies, WP-8), each group's failure caught and logged on its own. Answers
 * how many were told (rows written); 0 when the post did not cross here (below the threshold, past
 * 24 hours, already stamped, or past the threshold before any evaluation saw it below).
 *
 * Nobody acted in the notice's name: the row and the push carry the system actor, never the
 * author - an anonymous post stays anonymous, and a trend is the campus's, not a person's. The row's
 * `meta.media` says what the post shows when it has no text, so the bell can say "une photo"; its
 * `meta.likedBy` keeps the named account's ID and the count, never the name, which the bell
 * resolves when it is SERVED (`PostNotificationsService.resolveTrendLikedBy`) - an erasure, a block
 * or the share switch turned off then takes the name out of rows already written. The push carries
 * the name of the moment it is sent; a delivered push cannot be recalled.
 */
export async function announceCampusTrend(
  deps: {
    manager: Pick<EntityManager, 'query'>;
    notifications: Pick<PostNotificationsService, 'createNotificationRows' | 'pushNotice'>;
  },
  postId: string
): Promise<number> {
  const [result]: {
    announced: boolean;
    silent: boolean;
    markdown: string | null;
    images: unknown;
    eligible: number;
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
  const groups = groupByLikedBy(told);
  const named = told.length - (groups.get(NOBODY)?.recipients.length ?? 0);
  logger.log(
    `[TREND] post=${postId.slice(0, 8)} took off: ${told.length} to tell of ${result.eligible} ` +
      `eligible (${result.eligible - told.length} already told of a trend today, twice this week, ` +
      `or concurrently) media=${media ?? 'none'} named=${named}`
  );
  if (told.length === 0) return 0;
  const text = previewOf(result.markdown ?? '');
  const common = {
    type: CAMPUS_TREND_NOTIFICATION,
    postId,
    actorId: SYSTEM_ACTOR_ID,
    actorName: '',
    text,
  } as const;
  // EVERY ROW FIRST, in one insert: a push failing below can never cost a reader their bell row.
  const written = await deps.notifications.createNotificationRows({
    ...common,
    rows: [...groups.values()].flatMap(({ friendId, likedBy, recipients }) => {
      const meta = {
        ...(media ? { media } : {}),
        ...(friendId && likedBy ? { likedBy: { userId: friendId, others: likedBy.others } } : {}),
      };
      return recipients.map((recipientId) => ({
        recipientId,
        meta: Object.keys(meta).length ? meta : null,
      }));
    }),
  });
  // THEN ONE PUSH PER GROUP - the push carries the name as it is now.
  let failed = 0;
  for (const { likedBy, recipients } of groups.values()) {
    const meta = { ...(media ? { media } : {}), ...(likedBy ? { likedBy } : {}) };
    try {
      await deps.notifications.pushNotice({
        ...common,
        recipientIds: recipients,
        ...(Object.keys(meta).length ? { meta } : {}),
      });
    } catch (e: unknown) {
      failed++;
      logger.warn(
        `[TREND] post=${postId.slice(0, 8)} push to ${recipients.length} reader(s) failed ` +
          `(their bell rows are written): ${String(e)}`
      );
    }
  }
  logger.log(
    `[TREND] post=${postId.slice(0, 8)} told ${written}: ${groups.size} push group(s), ${failed} failed`
  );
  return written;
}

/** One reader the ledger took, with the followed account the trend names for them (or none). */
type TrendToldRow = {
  recipientId: string;
  friendId: string | null;
  /** How many OTHER accounts liked it - not the author, the named account or the reader. */
  others: number;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
};

/** The group key of the readers the trend names nobody to. */
const NOBODY = '';

/**
 * The told readers grouped by what their push says: the account named (and its id, which the row
 * keeps) and how many others liked it - `others` excludes the reader, so it can differ between two
 * readers who see the same account. An account with no name to show is not named - a trend never
 * prints an id.
 */
export function groupByLikedBy(
  told: readonly TrendToldRow[]
): Map<string, { friendId: string | null; likedBy: TrendLikedBy; recipients: string[] }> {
  const groups = new Map<
    string,
    { friendId: string | null; likedBy: TrendLikedBy; recipients: string[] }
  >();
  for (const row of told) {
    const name = row.friendId ? formatUserDisplayNameFromRaw(row) : '';
    const others = Math.max(0, row.others ?? 0);
    const key = name ? `${row.friendId}:${others}` : NOBODY;
    let group = groups.get(key);
    if (!group) {
      group = name
        ? { friendId: row.friendId, likedBy: { name, others }, recipients: [] }
        : { friendId: null, likedBy: null, recipients: [] };
      groups.set(key, group);
    }
    group.recipients.push(row.recipientId);
  }
  return groups;
}
