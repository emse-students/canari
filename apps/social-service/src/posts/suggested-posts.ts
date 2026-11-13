import type { EntityManager } from 'typeorm';
import { blockedAuthorSql, blockedUserIdsFor } from '../common/blocked-user-ids';
import { promoCutoffFor } from '../common/promo-visibility';
import {
  isMemberSql,
  isReaderSpaceSql,
  postReachesSpaceSql,
  postVisibleToUserSql,
  reviewCohortAuthorFilterSql,
} from '../spaces/reader-spaces';
import { engagedAccountsSql } from './engagement-sql';
import { Logger } from '@nestjs/common';
import { suggestionsOn } from '../push/notification-category';

const logger = new Logger('SuggestedPosts');

/**
 * SUGGESTED POSTS (engagement WP-7, decision 8): popular posts the viewer ALREADY sees by the SPACE
 * rule, from accounts they do not follow, offered in Mon espace marked "Suggestion" with Suivre in
 * the header - "nothing the viewer could not already see" (docs/wiki/engagement.md).
 *
 * WHICH POSTS - every clause a rule:
 * - The SPACE rule only: the post reaches one of the viewer's spaces (`postReachesSpaceSql`, which
 *   never counts a follow, a member repost or a read grant) AND the plain predicate holds
 *   (`postVisibleToUserSql` with `followers: false` and no grant - so the students-only gate and
 *   every other narrowing still apply). Never through a grant or a follower door.
 * - The feed's own block filter (`blockedAuthorSql`), as every feed row, the review cohort's author
 *   filter, the moderation hide, the schedule and the promo cutoff, as the feeds apply them.
 * - Not anonymous (the header's Suivre would have nobody to follow), not the viewer's own, and from
 *   an account the viewer does not follow or ask to follow, an association they neither follow nor
 *   belong to - a suggestion is about someone new.
 * - Posts only, not reels: CanaReels is its own viewer.
 * - Popular: at least {@link SUGGESTED_POST_MIN_ENGAGED} distinct accounts engaged
 *   (`engagedAccountsSql`), published within {@link SUGGESTED_POST_WINDOW_DAYS} days; the most
 *   engaged first, then the newest, then the id - deterministic.
 */

/** How many suggested posts one read returns. */
export const SUGGESTED_POSTS_MAX = 10;
/** How recent a suggested post is, in days, by the database's clock. */
export const SUGGESTED_POST_WINDOW_DAYS = 7;
/** How many distinct accounts must have engaged with a post for it to be suggested. */
export const SUGGESTED_POST_MIN_ENGAGED = 3;

/**
 * The ids of the viewer's suggested posts, best first. `$1` the viewer, `$2` the limit, then the
 * block list when there is one, then the promo cutoff when there is one.
 */
export function suggestedPostIdsSql(opts: {
  isAdmin: boolean;
  viewerId: string;
  blocked: boolean;
  promoCutoff: boolean;
  /** Pour toi (owner, 2026-11-10): a person's post only, never an entity's. */
  peopleOnly?: boolean;
}): string {
  const blockedParam = opts.blocked ? 3 : null;
  const promoParam = opts.blocked ? 4 : 3;
  const engaged = engagedAccountsSql('posts');
  return `SELECT sg.id FROM (
    SELECT posts.id, posts."publishedAt", ${engaged} AS engaged
      FROM posts
      JOIN users sg_viewer ON sg_viewer.id = $1::varchar
     WHERE posts.kind = 'post'
       AND (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= now())
       AND posts."publishedAt" > now() - make_interval(days => ${SUGGESTED_POST_WINDOW_DAYS})
       AND NOT COALESCE(posts."hiddenByModeration", false)
       AND NOT COALESCE(posts.anonymous, false)
       AND posts."authorId" <> $1::varchar
       ${opts.peopleOnly ? 'AND posts."associationId" IS NULL' : ''}
       ${reviewCohortAuthorFilterSql(opts.isAdmin, opts.viewerId)}
       ${blockedAuthorSql(blockedParam)}
       ${opts.promoCutoff ? `AND posts."publishedAt" >= $${promoParam}::timestamptz` : ''}
       AND (posts."associationId" IS NOT NULL OR NOT EXISTS (SELECT 1 FROM user_follows sg_f
             WHERE sg_f."followerUserId" = $1::varchar AND sg_f."followedUserId" = posts."authorId"))
       AND (posts."associationId" IS NULL OR (
             NOT EXISTS (SELECT 1 FROM association_follows sg_af
               WHERE sg_af."followerUserId" = $1::varchar AND sg_af."associationId" = posts."associationId")
             AND NOT ${isMemberSql('posts."associationId"', 'sg_viewer')}))
       AND EXISTS (SELECT 1 FROM spaces sg_space
             WHERE ${isReaderSpaceSql('sg_space', 'sg_viewer')} AND ${postReachesSpaceSql('posts', 'sg_space')})
       AND ${postVisibleToUserSql('posts', 'sg_viewer', { followers: false })}
  ) sg
  WHERE sg.engaged >= ${SUGGESTED_POST_MIN_ENGAGED}
  ORDER BY sg.engaged DESC, sg."publishedAt" DESC, sg.id
  LIMIT $2`;
}

/** The viewer's suggested post ids, best first, at most `limit`. Nobody signed in has none. */
export async function suggestedPostIds(
  manager: EntityManager,
  viewerId: string | undefined,
  isAdmin: boolean,
  limit = SUGGESTED_POSTS_MAX,
  opts: { peopleOnly?: boolean } = {}
): Promise<string[]> {
  if (!viewerId) return [];
  // ONE SWITCH, "Suggestions dans l'app", on by default (owner, "Deux niveaux", 2026-11-11): Pour
  // toi merges none and the older clients' route serves none for a reader who switched it off.
  if (!(await suggestionsOn(manager, viewerId))) {
    logger.debug(`[SUGGESTED_POSTS] ${viewerId.slice(0, 8)}: Suggestions off - none`);
    return [];
  }
  const [blocked, promoCutoff] = await Promise.all([
    blockedUserIdsFor(manager, viewerId),
    promoCutoffFor(manager, viewerId, isAdmin),
  ]);
  const params: unknown[] = [viewerId, Math.min(Math.max(limit, 1), SUGGESTED_POSTS_MAX)];
  if (blocked.length > 0) params.push(blocked);
  if (promoCutoff) params.push(promoCutoff);
  const rows: { id: string }[] = await manager.query(
    suggestedPostIdsSql({
      isAdmin,
      viewerId,
      blocked: blocked.length > 0,
      promoCutoff: promoCutoff !== null,
      peopleOnly: opts.peopleOnly === true,
    }),
    params
  );
  return rows.map((r) => r.id);
}
