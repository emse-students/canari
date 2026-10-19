import type { PostComment, PostEntity } from '$lib/posts/api';

/**
 * A POST'S COMMENT COUNT, AND ONE WRITE OF ITS THREAD AS A CHANGE (not as a list).
 *
 * A feed row carries only its newest comments (the server's `LIMIT 20`) and the real total in
 * `commentCount`, so the number a reader is told can never be `comments.length`: a post of 57
 * comments read "20". And a surface announcing a write to another (`publishPostComments`) cannot
 * hand over its LIST: the reel viewer's copy is a feed row, so a card holding the whole thread
 * would collapse to ~21 rows, and a comment written on the card a moment before could vanish. It
 * hands over what CHANGED - a row upserted, rows removed - and each surface applies it to its own
 * copy, which never shrinks except by an explicit removal.
 */

/** One write of a thread: a row added or replaced, or rows deleted, with what it does to the count. */
export type CommentChange =
  | { kind: 'upsert'; comment: PostComment }
  | { kind: 'remove'; ids: string[]; count: number };

/**
 * How many comments the post carries: the server's total when it sent one, never fewer than the
 * rows held (a server older than the field sends none).
 */
export function commentCountOf(post: Pick<PostEntity, 'comments' | 'commentCount'>): number {
  return Math.max(post.commentCount ?? 0, post.comments?.length ?? 0);
}

/** `post` with its count moved by `delta` - left absent when the server never sent one. */
export function withCommentCountDelta(post: PostEntity, delta: number): PostEntity {
  if (post.commentCount === undefined || post.commentCount === null) return post;
  return { ...post, commentCount: Math.max(0, post.commentCount + delta) };
}

/**
 * `post` with `change` applied to its own copy of the thread. An upsert of a row it does not hold
 * adds it and counts it; of one it holds, replaces it. A removal takes the named rows and their
 * replies, and moves the count by what the writer removed.
 */
export function applyCommentChange(post: PostEntity, change: CommentChange): PostEntity {
  const comments = post.comments ?? [];
  if (change.kind === 'upsert') {
    const held = comments.some((c) => c.id === change.comment.id);
    const next = held
      ? comments.map((c) => (c.id === change.comment.id ? change.comment : c))
      : [...comments, change.comment];
    return withCommentCountDelta({ ...post, comments: next }, held ? 0 : 1);
  }
  const gone = new Set(change.ids);
  const next = comments.filter((c) => !gone.has(c.id) && !(c.parentId && gone.has(c.parentId)));
  return withCommentCountDelta({ ...post, comments: next }, -change.count);
}
