import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { commentsWithheldFromViewerSql } from '../spaces/reader-spaces';

/**
 * A NAMED READER WHOSE ONLY DOOR TO A POST IS A READ GRANT, WITH "VOIT LES COMMENTAIRES" OFF (owner,
 * 2026-11-04; docs/wiki/profiles-and-access.md, "The nominative read grants - the decisions").
 *
 * Who it is, is ONE SQL predicate (`commentsWithheldFromViewerSql`). This module is the two halves
 * every consumer shares: which posts of a batch it holds for a reader (one query), and what such a
 * reader is handed of one post - no comments and no comment count, the reactions and the poll
 * votes as TOTALS, never who.
 */

const logger = new Logger('CommentsWithheld');

/**
 * Of `postIds`, those whose comments and people are withheld from `viewerId` - ONE query for a page.
 * An absent viewer matches no `users` row, so nothing is withheld from nobody (and nobody reads).
 */
export async function commentsWithheldPostIds(
  manager: EntityManager,
  postIds: readonly string[],
  viewerId: string | undefined
): Promise<Set<string>> {
  if (!viewerId || postIds.length === 0) return new Set();
  const rows: unknown = await manager.query(
    `SELECT posts.id FROM posts WHERE posts.id = ANY($1::uuid[])
       AND ${commentsWithheldFromViewerSql('posts', '$2')}`,
    [postIds, viewerId]
  );
  const withheld = new Set(Array.isArray(rows) ? (rows as { id: string }[]).map((r) => r.id) : []);
  if (withheld.size > 0) {
    // Expected for a named reader; the count is what tells a reading of the feed what was held.
    logger.debug(
      `[READ_GRANT] comments withheld from ${viewerId.slice(0, 8)} on ${withheld.size}/${postIds.length} post(s)`
    );
  }
  return withheld;
}

/** The reaction types of everybody BUT `viewerId`, counted: the tally a withheld reader is shown. */
export function otherReactionCounts(
  reactions: Record<string, string> | null | undefined,
  viewerId: string | undefined
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [userId, type] of Object.entries(reactions ?? {})) {
    if (userId === viewerId || typeof type !== 'string') continue;
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

/**
 * The reactions a withheld reader is handed: their OWN entry (so their reaction still shows as
 * theirs and toggles) and everybody else's as `otherReactionCounts` - never an id.
 */
export function withheldReactions(
  reactions: Record<string, string> | null | undefined,
  viewerId: string | undefined
): { reactions: Record<string, string>; otherReactionCounts: Record<string, number> } {
  const own = viewerId ? reactions?.[viewerId] : undefined;
  return {
    reactions: viewerId && typeof own === 'string' ? { [viewerId]: own } : {},
    otherReactionCounts: otherReactionCounts(reactions, viewerId),
  };
}

/**
 * A served poll list as a withheld reader is handed it: a NAMED poll's voter ids become a tally,
 * the way an anonymous poll already stores them (`anonymous-poll.ts`), and `votesByUser` keeps the
 * reader's own choice only. An anonymous poll is passed through: it names nobody already.
 */
export function withheldPolls(polls: unknown, viewerId: string | undefined): unknown {
  if (!Array.isArray(polls)) return polls;
  return polls.map((poll: Record<string, any>) => {
    if (!poll || poll.anonymous === true || !Array.isArray(poll.options)) return poll;
    const byUser: Record<string, unknown> =
      poll.votesByUser && typeof poll.votesByUser === 'object' ? poll.votesByUser : {};
    const mine = viewerId ? byUser[viewerId] : undefined;
    return {
      ...poll,
      options: poll.options.map((option: Record<string, any>) => ({
        ...option,
        votes: Array.isArray(option.votes)
          ? new Set(option.votes).size
          : typeof option.votes === 'number'
            ? option.votes
            : 0,
      })),
      votesByUser: viewerId && Array.isArray(mine) ? { [viewerId]: mine } : {},
    };
  });
}

/**
 * Strips, IN PLACE, what a withheld reader is not handed of one served post: `comments` and
 * `commentCount` go, the reactions become their own entry plus `otherReactionCounts`, the polls
 * become tallies, and `canSeeComments: false` tells the client to draw no comment control. Called by
 * the two points every served post goes through (`PostsService.shapeListRow`,
 * `toPublicPostFromEntity`), after `servePolls`.
 */
export function withholdCommentsAndPeople(
  post: Record<string, any>,
  viewerId: string | undefined
): void {
  delete post.comments;
  delete post.commentCount;
  if (post.reactions !== undefined) {
    const shaped = withheldReactions(post.reactions, viewerId);
    post.reactions = shaped.reactions;
    post.otherReactionCounts = shaped.otherReactionCounts;
  }
  if (post.polls !== undefined) post.polls = withheldPolls(post.polls, viewerId);
  post.canSeeComments = false;
}
