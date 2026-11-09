/**
 * WHO REPOSTED MY POST (WP-F6, owner 2026-11-02): the AUTHOR of a personal post reads the people who
 * reposted it to their followers, and removes one repost at a time. The server lists only the
 * people the author may otherwise meet - no one across a block, no store reviewer - and answers a
 * 404 to anyone but the author. The removed reposter is told nothing.
 *
 * A page is a follow-list page (`{ userId, createdAt, cursor }`, keyset on the repost's time), so
 * the sheet pages it with `nextFollowCursor` / `appendFollowPage`. Its own file because
 * `$lib/follows/api` imports `$lib/posts/api`: living there, these would close the cycle.
 */
import { socialRequest } from '$lib/posts/api';
import { FOLLOW_PAGE_SIZE, type FollowListEntry } from '$lib/follows/api';

/** The 404 code of a removal the author's list does not show (gone already, or never listed). */
export const MEMBER_REPOST_NOT_LISTED = 'MEMBER_REPOST_NOT_LISTED';

/** One page of the people who reposted `postId`, the most recent first, after `after`. */
export async function listPostReposters(
  postId: string,
  after?: string
): Promise<FollowListEntry[]> {
  const start = after ? `&after=${encodeURIComponent(after)}` : '';
  return socialRequest<FollowListEntry[]>(
    `/api/posts/${encodeURIComponent(postId)}/reposts?limit=${FOLLOW_PAGE_SIZE}${start}`
  );
}

/** The author removes `reposterId`'s repost of `postId`. */
export async function removePostRepost(postId: string, reposterId: string): Promise<void> {
  await socialRequest(
    `/api/posts/${encodeURIComponent(postId)}/reposts/${encodeURIComponent(reposterId)}`,
    { method: 'DELETE' }
  );
}
