import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { acceptedFollowSql } from '../follows/follow-status';
import { previewOf } from '../push/push-content';
import {
  commentsWithheldFromViewerSql,
  postVisibleToUserSql,
  sameSideOfReviewCohortSql,
} from '../spaces/reader-spaces';
import type { StoredComment } from './comment-identity';
import { FRIEND_COMMENT_NOTIFICATION, FRIEND_REACTION_NOTIFICATION } from './engagement-push-cap';
import type { PostNotificationsService } from './post-notifications.service';

const logger = new Logger('FriendActivity');

/** What X did on the post: the two acts friends' activity tells. */
export type FriendAct = 'reaction' | 'comment';

/**
 * RULE 8 - THE COMMENT SPEAKS AS X (docs/wiki/engagement.md, "(b) friends' activity"): a stored
 * comment keeps its writer's REAL `userId` whatever it says it is, so a comment that is anonymous,
 * written AS an association, or removed by moderation never produces an activity notice - naming X
 * would unmask an anonymous writer or the member behind an association's voice, or point at a
 * removed comment. Only a plain comment of X's own qualifies.
 */
export function commentSpeaksAsWriter(comment: StoredComment): boolean {
  return (
    comment.anonymous !== true && !comment.associationId && comment.removedByModeration !== true
  );
}

/**
 * THE DISCLOSURE RULE AND THE TOLD-ONCE LEDGER IN ONE STATEMENT (engagement WP-9). `$1` the post,
 * `$2` X (who acted), `$3` the act. Every accepted follower R of X is a candidate, and is told ONLY
 * when all of these hold - each a predicate that already exists, but rule 0:
 *
 * 0. X shares their activity: no `user_activity_settings` row saying otherwise (no row is ON).
 * 1. R follows X, accepted (`acceptedFollowSql`) - a pending request or an entity carries nothing.
 * 2. R sees P by the PLAIN predicate (`postVisibleToUserSql`, no read-grant door), so the
 *    students-only gate, the spaces, the follower and the repost doors all apply; the post is not
 *    hidden by moderation and not still scheduled.
 * 3. R would see X's act on P's own page: P's comments and reactors are not withheld from R
 *    (`commentsWithheldFromViewerSql`) - implied by rule 2's plain door, and asked anyway, so the
 *    rule does not rest on that implication.
 * 4. No block either way between R and X, nor between R and P's author.
 * 5. P is not anonymous when the act is a comment.
 * 6. R is not P's author (they get the existing notice), and X is not P's author.
 * 7. R has no row for P in the ledger or in `post_notifications` (told once, L14) - the
 *    announcement, a republication, a repost and the previous engagement notice all exclude them.
 * 8. The comment speaks as X - {@link commentSpeaksAsWriter}, asked before this statement runs.
 *
 * And never across the review cohort's boundary (built per call: the cohort is read from the
 * environment). `ORDER BY` gives every concurrent writer one lock order on the ledger's key;
 * `ON CONFLICT DO NOTHING RETURNING` answers exactly who THIS write told.
 */
export function friendActivityLedgerSql(): string {
  return `INSERT INTO post_engagement_notices ("postId", "recipientId", reason)
SELECT fa_post.id, fa_r.id, 'friend'
  FROM posts fa_post
  JOIN user_follows fa_f ON fa_f."followedUserId" = $2::varchar AND ${acceptedFollowSql('fa_f')}
  JOIN users fa_r ON fa_r.id = fa_f."followerUserId"
 WHERE fa_post.id = $1::uuid
   AND NOT EXISTS (SELECT 1 FROM user_activity_settings fa_set
                    WHERE fa_set."userId" = $2::varchar AND NOT fa_set."shareActivity")
   AND fa_post."authorId" <> $2::varchar
   AND fa_r.id <> fa_post."authorId"
   AND NOT COALESCE(fa_post."hiddenByModeration", false)
   AND (fa_post."scheduledAt" IS NULL OR fa_post."scheduledAt" <= now())
   AND ($3::varchar = 'reaction' OR NOT COALESCE(fa_post.anonymous, false))
   AND ${sameSideOfReviewCohortSql('fa_r.id', '$2::varchar')}
   AND NOT EXISTS (SELECT 1 FROM user_blocks fa_b
                    WHERE (fa_b."blockerId" = fa_r.id AND fa_b."blockedId" IN ($2::varchar, fa_post."authorId"))
                       OR (fa_b."blockedId" = fa_r.id AND fa_b."blockerId" IN ($2::varchar, fa_post."authorId")))
   AND ${postVisibleToUserSql('fa_post', 'fa_r')}
   AND NOT ${commentsWithheldFromViewerSql('fa_post', 'fa_r.id')}
   AND NOT EXISTS (SELECT 1 FROM post_notifications fa_n
                    WHERE fa_n."postId" = fa_post.id::text AND fa_n."recipientId" = fa_r.id)
 ORDER BY fa_r.id
ON CONFLICT DO NOTHING
RETURNING "recipientId"`;
}

/**
 * Tells X's followers what X just did on post `post`, under {@link friendActivityLedgerSql}:
 * the ledger first, then one in-app row and one push per reader THIS write told - the push through
 * `createNotifications`, so the bell and the daily cap (WP-8) apply as to any engagement push.
 * Called after the reaction or the comment is stored; answers how many readers were told.
 *
 * A failure is the caller's to log: the act itself is already stored, and nothing here retries -
 * a reader in the ledger whose row was not written is not told twice (told once, L14).
 */
export async function announceFriendActivity(
  deps: {
    manager: Pick<EntityManager, 'query'>;
    notifications: Pick<PostNotificationsService, 'createNotifications'>;
  },
  input: {
    post: { id: string; markdown?: string | null };
    actorId: string;
    act: FriendAct;
    /** The stored comment, for a comment: rule 8 is asked of it. */
    comment?: StoredComment;
  }
): Promise<number> {
  const { post, actorId, act, comment } = input;
  if (act === 'comment' && (!comment || !commentSpeaksAsWriter(comment))) {
    logger.debug(`[FRIEND_ACTIVITY] post=${post.id.slice(0, 8)} comment not in its writer's name`);
    return 0;
  }
  const rows: { recipientId: string }[] = await deps.manager.query(friendActivityLedgerSql(), [
    post.id,
    actorId,
    act,
  ]);
  if (rows.length === 0) {
    logger.debug(`[FRIEND_ACTIVITY] post=${post.id.slice(0, 8)} act=${act}: nobody to tell`);
    return 0;
  }
  await deps.notifications.createNotifications({
    recipientIds: rows.map((r) => r.recipientId),
    type: act === 'reaction' ? FRIEND_REACTION_NOTIFICATION : FRIEND_COMMENT_NOTIFICATION,
    postId: post.id,
    actorId,
    text: previewOf(post.markdown ?? ''),
  });
  logger.log(`[FRIEND_ACTIVITY] post=${post.id.slice(0, 8)} act=${act}: ${rows.length} told`);
  return rows.length;
}
