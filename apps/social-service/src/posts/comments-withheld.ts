import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { commentsWithheldFromViewerSql } from '../spaces/reader-spaces';
import { isUnsafeObjectKey, withOwnEntry } from '../common/object-keys';

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

/**
 * `{ [viewerId]: value }` as a prototype-less map, or an empty one when there is no viewer, no
 * value, or a viewer id that is no safe property name (`common/object-keys.ts`) - the one entry a
 * withheld reader keeps of a map keyed by people. Built through `withOwnEntry`, never a computed
 * key, so an id off a request cannot reach a prototype.
 */
export function ownEntryOnly<V>(
  viewerId: string | undefined,
  value: V | undefined,
  isValue: (v: unknown) => v is V
): Record<string, V> {
  if (!viewerId || !isValue(value)) return Object.create(null) as Record<string, V>;
  if (isUnsafeObjectKey(viewerId)) {
    logger.warn(`[READ_GRANT] own entry not served: viewer id is no safe key`);
    return Object.create(null) as Record<string, V>;
  }
  return withOwnEntry<V>(null, viewerId, value);
}

const isString = (v: unknown): v is string => typeof v === 'string';

/**
 * The reaction types of everybody BUT `viewerId`, counted: the tally a withheld reader is shown.
 * Counted in a `Map` and served as a prototype-less object: a reaction type is a string the client
 * sent, so a type that is no safe property name (`__proto__`, ...) is skipped and logged, as
 * `sanitizeReactions` skips such a user id - it is no reaction the app draws.
 */
export function otherReactionCounts(
  reactions: Record<string, string> | null | undefined,
  viewerId: string | undefined
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const [userId, type] of Object.entries(reactions ?? {})) {
    if (userId === viewerId || typeof type !== 'string') continue;
    if (isUnsafeObjectKey(type)) {
      logger.warn(`[READ_GRANT] a reaction of an unsafe type left out of the tally`);
      continue;
    }
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return Object.assign(Object.create(null) as Record<string, number>, Object.fromEntries(counts));
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
    reactions: ownEntryOnly(viewerId, own, isString),
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
      votesByUser: ownEntryOnly(viewerId, mine, (v): v is unknown[] => Array.isArray(v)),
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
