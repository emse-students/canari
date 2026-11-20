import { ConflictException, Logger } from '@nestjs/common';

const logger = new Logger('CommentPublication');

/** The stable code the client may map to its own sentence - never the message. */
export const COMMENT_POST_NOT_PUBLISHED = 'COMMENT_POST_NOT_PUBLISHED';

/**
 * A POST THAT IS NOT PUBLISHED YET TAKES NO COMMENT (owner, 2026-11-19: "On ne devrait pas pouvoir
 * commenter un post programme."). `publishedAt` is the instant the post becomes visible
 * (`publication-time.ts`), so a value in the future is a scheduled post - for every author, the
 * post's own included. Refused as a typed 409, never a message to parse. A row with no
 * `publishedAt` (a unit stand-in) is published.
 *
 * @throws ConflictException carrying {@link COMMENT_POST_NOT_PUBLISHED}.
 */
export function assertPostAcceptsComments(
  post: { id: string; publishedAt?: Date | string | null },
  now: Date
): void {
  if (!post.publishedAt || new Date(post.publishedAt).getTime() <= now.getTime()) return;
  logger.debug(`comment refused: post ${post.id.slice(0, 8)} is not published yet`);
  throw new ConflictException({
    code: COMMENT_POST_NOT_PUBLISHED,
    message: 'A post that is not published yet takes no comment.',
  });
}
