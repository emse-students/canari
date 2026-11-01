import { postVisibleToViewerSql } from '../spaces/reader-spaces';
import { acceptedFollowSql } from '../follows/follow-status';
import { FIRST_HAND, repostConsentSql, type RepostConsent } from './member-reposts.service';

/** A person named on a card as having reposted it (WP-F6). */
export interface Reposter {
  id: string;
  name: string;
}

/** What a page of cards needs to know about member reposts, for ONE reader (WP-F6). */
export interface MemberRepostContext {
  /** Posts the reader may repost now - `MemberRepostsService.repost`'s refusals as one predicate. */
  repostable: Set<string>;
  /** Posts the reader has reposted ("Annuler ma republication"). */
  mine: Set<string>;
  /** Per post, the reposters the reader FOLLOWS (accepted), oldest repost first. */
  reposters: Map<string, Reposter[]>;
  /** Per post the reader AUTHORED (personal, not anonymous), its consent. */
  consent: Map<string, RepostConsent>;
}

/** The context of a reader who holds nothing. */
export const EMPTY_MEMBER_REPOST_CONTEXT: MemberRepostContext = {
  repostable: new Set(),
  mine: new Set(),
  reposters: new Map(),
  consent: new Map(),
};

type Runner = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

/**
 * The member-repost fields of a page of cards, in TWO queries whatever its length (WP-F6).
 *
 * `repostable` restates the write's refusals - not withheld, not anonymous, not the reader's own
 * personal post, seen WITHOUT a grant and without the administrator's by-id reach, no block with a
 * personal post's author, the author consents, not already reposted - so the menu entry is offered
 * exactly when the write would be accepted.
 *
 * `reposters` names only the people the reader follows: the card says "Republie par Y" to someone
 * who is in Y's audience, and to nobody else - who reposted a post is not news to a stranger.
 */
export async function memberRepostContext(
  manager: Runner,
  postIds: string[],
  viewerId: string
): Promise<MemberRepostContext> {
  if (postIds.length === 0) return EMPTY_MEMBER_REPOST_CONTEXT;
  const [state, named] = await Promise.all([
    manager.query(
      `SELECT posts.id,
              EXISTS (SELECT 1 FROM member_reposts mc_mine
                       WHERE mc_mine."postId" = posts.id AND mc_mine."reposterId" = $2) AS mine,
              (posts."associationId" IS NULL AND posts."authorId" = $2
                AND NOT COALESCE(posts.anonymous, false)) AS own,
              posts."allowReposts" AS override,
              ${repostConsentSql('posts')} AS consents,
              (NOT COALESCE(posts.anonymous, false)
                AND NOT COALESCE(posts."hiddenByModeration", false)
                AND (posts."scheduledAt" IS NULL OR posts."scheduledAt" <= now())
                AND NOT (posts.kind = 'reel' AND posts."expiresAt" IS NOT NULL AND posts."expiresAt" <= now())
                AND NOT (posts."associationId" IS NULL AND posts."authorId" = $2)
                AND ${postVisibleToViewerSql('posts', '$2', FIRST_HAND)}
                AND NOT (posts."associationId" IS NULL AND EXISTS (SELECT 1 FROM user_blocks mc_block
                  WHERE (mc_block."blockerId" = $2 AND mc_block."blockedId" = posts."authorId")
                     OR (mc_block."blockerId" = posts."authorId" AND mc_block."blockedId" = $2)))
                AND ${repostConsentSql('posts')}) AS repostable
         FROM posts WHERE posts.id = ANY($1::uuid[])`,
      [postIds, viewerId]
    ),
    manager.query(
      `SELECT mc_rep."postId", u.id, u."displayName", u."firstName", u."lastName"
         FROM member_reposts mc_rep
         JOIN posts mc_post ON mc_post.id = mc_rep."postId" AND NOT COALESCE(mc_post.anonymous, false)
         JOIN user_follows mc_follow ON mc_follow."followedUserId" = mc_rep."reposterId"
           AND mc_follow."followerUserId" = $2 AND ${acceptedFollowSql('mc_follow')}
         JOIN users u ON u.id = mc_rep."reposterId"
        WHERE mc_rep."postId" = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM user_blocks mc_rblock
            WHERE (mc_rblock."blockerId" = $2 AND mc_rblock."blockedId" = mc_rep."reposterId")
               OR (mc_rblock."blockerId" = mc_rep."reposterId" AND mc_rblock."blockedId" = $2))
        ORDER BY mc_rep."repostedAt" ASC, u.id ASC`,
      [postIds, viewerId]
    ),
  ]);
  const out: MemberRepostContext = {
    repostable: new Set(),
    mine: new Set(),
    reposters: new Map(),
    consent: new Map(),
  };
  const rows = Array.isArray(state)
    ? (state as {
        id: string;
        mine: boolean;
        own: boolean;
        override: boolean | null;
        consents: boolean;
        repostable: boolean;
      }[])
    : [];
  for (const row of rows) {
    if (row.mine) out.mine.add(row.id);
    else if (row.repostable) out.repostable.add(row.id);
    if (row.own) {
      out.consent.set(row.id, { override: row.override ?? null, effective: row.consents === true });
    }
  }
  const names = Array.isArray(named)
    ? (named as {
        postId: string;
        id: string;
        displayName: string | null;
        firstName: string | null;
        lastName: string | null;
      }[])
    : [];
  for (const row of names) {
    const name = row.displayName?.trim() || `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim();
    const list = out.reposters.get(row.postId) ?? [];
    list.push({ id: row.id, name });
    out.reposters.set(row.postId, list);
  }
  return out;
}
