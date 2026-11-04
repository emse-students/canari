import type { EntityManager } from 'typeorm';
import { blockedUserIdsFor } from '../common/blocked-user-ids';
import { postVisibleToViewerSql, type PostAccessIntent } from '../spaces/reader-spaces';
import { commentsWithheldPostIds } from './comments-withheld';
import { isExpiredReel, type PostKind } from './reel.constants';

/**
 * The columns of a `posts` row the open-a-post gate reads - an entity or a raw row both fit, so a
 * service that cannot inject `PostsService` (moderation, which `PostsModule` imports) asks the SAME
 * gate from its own query.
 */
export interface OpenablePost {
  id: string;
  authorId: string;
  associationId?: string | null;
  anonymous?: boolean | null;
  hiddenByModeration?: boolean | null;
  scheduledAt?: Date | string | null;
  kind?: PostKind | null;
  expiresAt?: Date | string | null;
}

/**
 * The gate's answer. `refusal` is null when the post opens; `not-found` is every refusal the read
 * answers with a 404 (for that reader the post does not exist); `hidden` is the one it answers with
 * a 403 (moderation hid a post the reader may otherwise see). `why` is for the caller's log line,
 * never for a response body. `blockedIds` (the reader's blocks, either way) is read only when the
 * gate got that far, and empty otherwise.
 */
export interface PostOpenVerdict {
  refusal: 'not-found' | 'hidden' | null;
  why: string;
  blockedIds: string[];
}

const refuse = (refusal: 'not-found' | 'hidden', why: string): PostOpenVerdict => ({
  refusal,
  why,
  blockedIds: [],
});

/**
 * WHETHER ONE READER MAY OPEN ONE POST - THE ONE PREDICATE every path that acts on a post asks:
 * the read by id (`PostsService.getById`), a vote, a reaction, a comment, a comment like, the
 * comment page, the recipients of a mention, and a report. A write or a notification that skipped a
 * term of it would reach a post the read refuses: a mention would push the text of a post to a
 * reader outside its audience, a reaction would land on a post its author's block hides, and a
 * report - five of which hide a post - could be filed by someone who was never shown it.
 *
 * The terms, IN THIS ORDER (the order is the read's, and it matters for what a refusal reveals):
 * 1. a reel past its month is gone for everyone (`isExpiredReel`);
 * 2. the audience - `postVisibleToViewerSql`, a global admin included (opening by id is a
 *    moderation path - for an "Entre étudiants" post only with `allowHidden`, the moderation read);
 *    a read grant counts for `'READ_OR_REACT'` and `'COMMENT'`, never for `'VOTE'`. BEFORE the
 *    moderation term, whose 403 would otherwise confirm the id to someone outside the audience;
 *    for `'COMMENT'`, also: the comments are not withheld from this reader (a named reader whose
 *    only door is the grant, switch off - `commentsWithheldPostIds`, owner 2026-11-04), else a 404:
 *    for that reader the comments do not exist;
 * 3. hidden by moderation, unless `allowHidden` (a platform admin doing platform work);
 * 4. scheduled later, unless the reader wrote it (or `allowHidden`): an unpublished post's existence
 *    is itself what is hidden;
 * 5. a block either way between the reader and the author of a PERSONAL, NON-ANONYMOUS post (or
 *    `allowHidden`). An association or anonymous post is exempt, as in every feed: filtering it on
 *    its author would make a block a de-anonymisation oracle (`PostsService.blockedAuthorSql`).
 *
 * Returns the reader's blocks on success: the serving that follows needs them anyway.
 */
export async function readPostOpenVerdict(
  manager: EntityManager,
  post: OpenablePost,
  opts: { viewerId?: string; allowHidden?: boolean },
  intent: PostAccessIntent
): Promise<PostOpenVerdict> {
  if (isExpiredReel(post)) return refuse('not-found', `reel expired at ${String(post.expiresAt)}`);
  const rows: { visible: boolean }[] = await manager.query(
    // `adminModerates` only with `allowHidden`: a platform admin opens an "Entre étudiants" post to
    // MODERATE it (read it, its comments), never to react, comment or vote (lead, 2026-11-04).
    `SELECT ${postVisibleToViewerSql('posts', '$2', { adminSeesAll: true, adminModerates: opts.allowHidden === true, readGrants: intent !== 'VOTE' })} AS visible FROM posts WHERE posts.id = $1`,
    [post.id, opts.viewerId ?? null]
  );
  if (rows[0]?.visible !== true) return refuse('not-found', 'outside its audience');
  if (
    intent === 'COMMENT' &&
    (await commentsWithheldPostIds(manager, [post.id], opts.viewerId)).has(post.id)
  ) {
    return refuse('not-found', 'comments withheld from a grant-only reader');
  }
  if (post.hiddenByModeration && !opts.allowHidden) return refuse('hidden', 'hidden by moderation');
  const scheduledAt = post.scheduledAt ? new Date(post.scheduledAt) : null;
  const viewerOwnsIt = !!opts.viewerId && post.authorId === opts.viewerId;
  if (scheduledAt && scheduledAt.getTime() > Date.now() && !viewerOwnsIt && !opts.allowHidden) {
    return refuse('not-found', `scheduled for ${scheduledAt.toISOString()}`);
  }
  const blockedIds = await blockedUserIdsFor(manager, opts.viewerId);
  if (
    !post.associationId &&
    !post.anonymous &&
    blockedIds.includes(post.authorId) &&
    !opts.allowHidden
  ) {
    return refuse('not-found', 'a block stands between the reader and its author');
  }
  return { refusal: null, why: 'open', blockedIds };
}
