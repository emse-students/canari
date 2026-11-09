/**
 * The server's stable code for a reply to, or a like of, a comment moderation removed (a 409 from
 * social-service, `posts/comment-removal.ts`). A tombstone is a row kept only so the protected
 * replies under it keep their context: it takes no new reply and no heart, so nothing new ever
 * reaches its moderated writer. A reader meets the refusal only when their copy of the thread still
 * showed the comment live. Its own module so a screen can import it without the posts API.
 */
export const COMMENT_REMOVED_BY_MODERATION = 'COMMENT_REMOVED_BY_MODERATION';
