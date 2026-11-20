import { ConflictException, Logger } from '@nestjs/common';

const logger = new Logger('CommentPublication');

/** The stable code the client may map to its own sentence - never the message. */
export const COMMENT_POST_NOT_PUBLISHED = 'COMMENT_POST_NOT_PUBLISHED';

/**
 * A POST THAT IS NOT PUBLISHED YET TAKES NO COMMENT (owner, 2026-11-19: "On ne devrait pas pouvoir
 * commenter un post programme."), for every author, the post's own included. The decision is the
 * database's, taken under the post row's lock by `writeComments` (`PUBLISHED_SQL`, the feed's own
 * predicate): a reschedule committed while an add waits is seen by it. Refused as a typed 409,
 * never a message to parse.
 *
 * @throws ConflictException carrying {@link COMMENT_POST_NOT_PUBLISHED}.
 */
export function refuseUnpublishedPost(postId: string): never {
  logger.debug(`comment refused: post ${postId.slice(0, 8)} is not published yet`);
  throw new ConflictException({
    code: COMMENT_POST_NOT_PUBLISHED,
    message: 'A post that is not published yet takes no comment.',
  });
}
