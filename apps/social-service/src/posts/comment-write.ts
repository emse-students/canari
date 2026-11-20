import { Logger, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { StoredComment } from './comment-identity';
import { refuseUnpublishedPost } from './comment-publication';
import { PUBLISHED_SQL } from './publication-time';

const logger = new Logger('CommentWrite');

/** What a comment write decided: the post's comments to store (none: nothing changes), and its answer. */
export interface CommentsWrite<T> {
  next?: StoredComment[];
  result: T;
}

/**
 * THE ONE WAY `posts.comments` IS WRITTEN (lead's review of #2999, 2026-11-04).
 *
 * The comments of a post are one `jsonb` array, so every write of one of them is a read-modify-write
 * of the whole array: two writers that each read it and each store their copy lose one of the two
 * writes - an add racing a moderation delete brought the removed comment back, or lost the reply.
 * Every comment writer (add, like, edit, delete, the moderation delete) therefore runs here: in one
 * transaction, the post row locked (`SELECT ... FOR UPDATE`), the array read UNDER the lock, decided
 * by `write`, and stored by an `UPDATE` of that column alone. A second writer waits for the lock and
 * reads the first one's result - serialised, never merged after the fact.
 *
 * The column is `update: false` on the entity, so no `save(post)` elsewhere (a reaction, an edit of
 * the post, a hide) can write back the stale copy it loaded: this is its only writer, with account
 * erasure's own locked statement.
 *
 * @param manager The entity manager to open the transaction on (any service's).
 * @param write Decides from the locked comments; may await (the rights of the writer are asked of
 *   the rows it sees under the lock). Throwing rolls the transaction back.
 * @param opts.requirePublished Refuse (typed 409) a post not published yet, decided in the SAME locked
 *   read on the database clock, so a reschedule committed while the writer waited is seen.
 * @throws NotFoundException when the post is gone.
 */
export async function writeComments<T>(
  manager: EntityManager,
  postId: string,
  write: (comments: StoredComment[]) => Promise<CommentsWrite<T>> | CommentsWrite<T>,
  opts: { requirePublished?: boolean } = {}
): Promise<T> {
  return manager.transaction(async (m) => {
    const rows: { comments: StoredComment[] | null; published?: boolean }[] = await m.query(
      `SELECT comments, ${PUBLISHED_SQL} AS published FROM posts WHERE id = $1 FOR UPDATE`,
      [postId]
    );
    if (rows.length === 0) {
      logger.debug(`writeComments ${postId.slice(0, 8)}: no post`);
      throw new NotFoundException('Post not found');
    }
    if (opts.requirePublished && rows[0].published === false) refuseUnpublishedPost(postId);
    const { next, result } = await write(rows[0].comments ?? []);
    if (next) {
      await m.query(`UPDATE posts SET comments = $2::jsonb WHERE id = $1`, [
        postId,
        JSON.stringify(next),
      ]);
    }
    return result;
  });
}

/**
 * THE BELL FORGETS WHAT A DELETE TOOK (lead's review of #2999): a row about a removed comment is
 * deleted, and a row about a comment left as a moderation tombstone keeps its place but loses the
 * text it quoted - the preview of a moderated comment must not outlive it in anyone's bell. Rows are
 * found by `post_notifications."commentId"` (migration 132); a row older than that column names no
 * comment and is left as it is.
 *
 * Best effort AFTER the delete committed: a bell that could not be cleaned does not undo the delete,
 * and the failure is logged at a level that accuses.
 */
export async function forgetCommentNotices(
  manager: Pick<EntityManager, 'query'>,
  postId: string,
  removedIds: readonly string[],
  tombstonedIds: readonly string[]
): Promise<void> {
  if (removedIds.length === 0 && tombstonedIds.length === 0) return;
  try {
    if (removedIds.length > 0) {
      await manager.query(
        `DELETE FROM post_notifications WHERE "postId" = $1 AND "commentId" = ANY($2::varchar[])`,
        [postId, [...removedIds]]
      );
    }
    if (tombstonedIds.length > 0) {
      await manager.query(
        `UPDATE post_notifications SET text = '' WHERE "postId" = $1 AND "commentId" = ANY($2::varchar[])`,
        [postId, [...tombstonedIds]]
      );
    }
    logger.debug(
      `forgetCommentNotices post=${postId.slice(0, 8)} removed=${removedIds.length} tombstoned=${tombstonedIds.length}`
    );
  } catch (e) {
    logger.error(
      `[NOTIFY] bell rows of deleted comments NOT forgotten post=${postId.slice(0, 8)} removed=${removedIds.length} tombstoned=${tombstonedIds.length}`,
      e
    );
  }
}
