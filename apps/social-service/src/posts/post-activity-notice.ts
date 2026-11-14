import type { EntityManager } from 'typeorm';
import { ONE_PER_POST_TYPES } from './engagement-push-cap';

/**
 * ONE LIVE NOTIFICATION PER POST for the comments and reactions on the reader's own post (owner,
 * 2026-11-14; docs/wiki/engagement.md, "The owner's decision of 2026-11-14"): never counted by the
 * daily cap, never dropped; it ALERTS when the post had no unread bell row, and updates SILENTLY
 * while one stands. No timer: the bell's own read state decides.
 */

/** The data field carrying the per-post identity every platform replaces by. */
export const POST_ACTIVITY_COLLAPSE_PREFIX = 'post_activity_';

/** The stable identity of one post's notification: APNs collapse id, Android stable id, thread. */
export function postActivityCollapseId(postId: string): string {
  return `${POST_ACTIVITY_COLLAPSE_PREFIX}${postId}`;
}

/**
 * The ONE lock that orders every write of a reader's unread state: the claim below and the two read
 * writes (`markAllRead`, `markPostRead`). Per RECIPIENT, not per post, because `markAllRead` covers
 * every post: a read that lands first makes the next comment alert, a comment that lands first is
 * covered by the read after it - a comment is never inserted silent just after the bell was cleared.
 * A hash collision only orders two unrelated readers; it never changes an answer.
 */
export const POST_ACTIVITY_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('post_notifications_unread:' || $1, 0))`;

/**
 * The decision and the row in ONE statement, run under {@link POST_ACTIVITY_LOCK_SQL}: the post's
 * prior UNREAD rows of the collapsed types (read in the statement's snapshot, so the row it inserts
 * is not among them), the insert, and the answer - `alert` when there was none, `others` the distinct
 * OTHER actors of the same type among them. An actor id equal to `$8` (anonymous, or an association
 * speaking - the id names nobody) counts per row.
 *
 * `$1` recipient, `$2` post, `$3` type, `$4` actor id, `$5` actor name, `$6` text, `$7` comment id,
 * `$8` the anonymous actor id, `$9` the collapsed types.
 */
export const POST_ACTIVITY_WRITE_SQL = `WITH prior AS (
  SELECT id, type, "actorId" FROM post_notifications
   WHERE "recipientId" = $1 AND "postId" = $2 AND NOT read AND type = ANY($9::varchar[])
), written AS (
  INSERT INTO post_notifications ("recipientId", type, "postId", "actorId", "actorName", text, "commentId")
  VALUES ($1, $3, $2, $4, $5, $6, $7)
  RETURNING id
)
SELECT (SELECT count(*) FROM prior) = 0 AS alert,
       (SELECT count(DISTINCT CASE WHEN "actorId" = $8 THEN 'row:' || id::text ELSE "actorId" END)
          FROM prior
         WHERE type = $3 AND ("actorId" <> $4 OR "actorId" = $8))::int AS others,
       (SELECT id FROM written) AS id`;

/** One comment or reaction row about to be written for the post's author. */
export interface PostActivityRow {
  recipientId: string;
  type: 'comment' | 'reaction';
  postId: string;
  actorId: string;
  actorName: string;
  text: string;
  commentId?: string | null;
  /** The id a masked actor carries (`ANONYMOUS_NOTIFICATION_ACTOR_ID`), counted per row. */
  anonymousActorId: string;
}

/** What the claim decided: ring or update in silence, and how many OTHER people the line names. */
export interface PostActivityVerdict {
  alert: boolean;
  others: number;
}

/**
 * Writes `row` and decides, in ONE transaction under the reader's lock, whether its push alerts.
 * Two comments arriving together are serialised by the lock: exactly one alerts.
 */
export async function writePostActivityRow(
  manager: Pick<EntityManager, 'transaction'>,
  row: PostActivityRow
): Promise<PostActivityVerdict> {
  return manager.transaction(async (tx) => {
    await tx.query(POST_ACTIVITY_LOCK_SQL, [row.recipientId]);
    const rows: { alert: boolean; others: number }[] = await tx.query(POST_ACTIVITY_WRITE_SQL, [
      row.recipientId,
      row.postId,
      row.type,
      row.actorId,
      row.actorName,
      row.text,
      row.commentId ?? null,
      row.anonymousActorId,
      ONE_PER_POST_TYPES,
    ]);
    return { alert: rows[0].alert, others: rows[0].others };
  });
}

/** Marks rows read under the reader's lock (`POST_ACTIVITY_LOCK_SQL`), so a claim never races it. */
export async function markReadUnderLock(
  manager: Pick<EntityManager, 'transaction'>,
  recipientId: string,
  postId: string | null
): Promise<void> {
  await manager.transaction(async (tx) => {
    await tx.query(POST_ACTIVITY_LOCK_SQL, [recipientId]);
    await tx.query(
      postId === null
        ? `UPDATE post_notifications SET read = true WHERE "recipientId" = $1 AND NOT read`
        : `UPDATE post_notifications SET read = true WHERE "recipientId" = $1 AND "postId" = $2 AND NOT read`,
      postId === null ? [recipientId] : [recipientId, postId]
    );
  });
}
