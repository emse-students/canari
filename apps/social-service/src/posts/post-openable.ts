import type { EntityManager } from 'typeorm';
import { blockedUserIdsFor } from '../common/blocked-user-ids';
import {
  authorDoorHoldsSql,
  postVisibleToViewerSql,
  type PostAccessIntent,
} from '../spaces/reader-spaces';
import { commentsWithheldPostIds } from './comments-withheld';
import { isExpiredPost, type StoredPostKind } from './reel.constants';

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
  kind?: StoredPostKind | null;
  expiresAt?: Date | string | null;
  /** The live a `replay` names; read only for that kind. */
  liveId?: string | null;
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
 * 1. a reel past its month is gone for everyone (`isExpiredPost`);
 * 2. the audience - `postVisibleToViewerSql`. A platform admin is widened past it ONLY with
 *    `allowHidden`, the moderation read (the post by id, its comment page): every other caller - a
 *    reaction, a comment, a comment like or edit, a vote, a report, a mention - asks an admin the
 *    ordinary reader's right, so an admin reads by id to moderate and never participates outside
 *    their own audience (2026-11-14, profiles-and-access.md). `adminSeesCohort` is a live replay's
 *    watch, the live's own exception (a review account's replay, to judge a report);
 *    a read grant counts for `'READ_OR_REACT'` and `'COMMENT'`, never for `'VOTE'`. BEFORE the
 *    moderation term, whose 403 would otherwise confirm the id to someone outside the audience;
 *    for `'COMMENT'`, also: the comments are not withheld from this reader (a named reader whose
 *    only door is the grant, switch off - `commentsWithheldPostIds`, owner 2026-11-04), else a 404:
 *    for that reader the comments do not exist;
 * 3. hidden by moderation, unless `allowHidden` (a platform admin doing platform work);
 * 4. scheduled later, unless the reader holds its author's door (`authorDoorHoldsSql`: wrote it, and
 *    for an entity's post still holds a role there) or `allowHidden`: an unpublished post's existence
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
  opts: { viewerId?: string; allowHidden?: boolean; adminSeesCohort?: boolean },
  intent: PostAccessIntent
): Promise<PostOpenVerdict> {
  if (isExpiredPost(post)) return refuse('not-found', `reel expired at ${String(post.expiresAt)}`);
  // The admin's widening is the MODERATION READ alone (`allowHidden`): a platform admin opens any
  // post by id to moderate it - an "Entre étudiants" one included (lead, 2026-11-04) - and never
  // reacts, comments, votes or reports outside their own audience (2026-11-14).
  const moderates = opts.allowHidden === true;
  const rows: { visible: boolean }[] = await manager.query(
    `SELECT ${postVisibleToViewerSql('posts', '$2', {
      adminSeesAll: moderates,
      adminModerates: moderates,
      adminSeesCohort: opts.adminSeesCohort === true,
      readGrants: intent !== 'VOTE',
    })} AS visible FROM posts WHERE posts.id = $1`,
    [post.id, opts.viewerId ?? null]
  );
  if (rows[0]?.visible !== true) return refuse('not-found', 'outside its audience');
  if (post.kind === 'replay' && (await removedFromReplayLive(manager, post, opts.viewerId))) {
    return refuse('not-found', 'removed from the live by its broadcaster');
  }
  if (
    intent === 'COMMENT' &&
    (await commentsWithheldPostIds(manager, [post.id], opts.viewerId)).has(post.id)
  ) {
    return refuse('not-found', 'comments withheld from a grant-only reader');
  }
  if (post.hiddenByModeration && !opts.allowHidden) return refuse('hidden', 'hidden by moderation');
  const scheduledAt = post.scheduledAt ? new Date(post.scheduledAt) : null;
  if (
    scheduledAt &&
    scheduledAt.getTime() > Date.now() &&
    !opts.allowHidden &&
    !(await viewerHoldsAuthorDoor(manager, post, opts.viewerId))
  ) {
    return refuse('not-found', `scheduled for ${scheduledAt.toISOString()}`);
  }
  const blockedIds = await blockedUserIdsFor(manager, opts.viewerId);
  // A live replay is the broadcaster on screen: a block hides it as it hid the live, an
  // association's live included (docs/wiki/live-replays.md section 4).
  if (
    (!post.associationId || post.kind === 'replay') &&
    !post.anonymous &&
    blockedIds.includes(post.authorId) &&
    !opts.allowHidden
  ) {
    return refuse('not-found', 'a block stands between the reader and its author');
  }
  return { refusal: null, why: 'open', blockedIds };
}

/**
 * The viewer holds the post's AUTHOR'S DOOR (`authorDoorHoldsSql`): its writer, and for a post in an
 * entity's name only while they still hold a role there - what "unless the reader wrote it" means
 * for a post scheduled later. Asked of a scheduled post alone, so an ordinary read pays no query.
 */
async function viewerHoldsAuthorDoor(
  manager: EntityManager,
  post: OpenablePost,
  viewerId: string | undefined
): Promise<boolean> {
  if (!viewerId || viewerId !== post.authorId) return false;
  const rows: { holds: boolean }[] = await manager.query(
    `SELECT ${authorDoorHoldsSql('posts', '$2')} AS holds FROM posts WHERE posts.id = $1`,
    [post.id, viewerId]
  );
  return rows[0]?.holds === true;
}

/**
 * A LIVE REPLAY IS NEVER SHOWN TO A VIEWER ITS BROADCASTER REMOVED FROM THE LIVE (lead decision,
 * docs/wiki/live-replays.md section 4): a removal was the broadcaster's statement about that person,
 * and a replay served to them would undo it. Read from `live_removed_viewers`, whose rows live as long
 * as the live row - which the purge deletes only once the replay post is gone. Asked of a `replay`
 * alone, after the audience term (so it confirms nothing to an outsider). The author is never removed.
 */
async function removedFromReplayLive(
  manager: EntityManager,
  post: OpenablePost,
  viewerId: string | undefined
): Promise<boolean> {
  if (!viewerId || viewerId === post.authorId) return false;
  const rows: unknown[] = await manager.query(
    `SELECT 1 FROM live_removed_viewers rv JOIN posts p ON p."liveId" = rv."liveId"
      WHERE p.id = $1 AND rv."viewerId" = $2`,
    [post.id, viewerId]
  );
  return rows.length > 0;
}
