import { listPosts, type PostEntity } from '$lib/posts/api';

/**
 * THE LIST THE REEL VIEWER SWIPES THROUGH (C7): every live reel the reader may see, and since
 * 2026-10-19 every post whose only content is ONE picture (user: photos in CanaReels, as on
 * Instagram), newest first, whatever tab the feed is on - the server narrows
 * (`GET /api/posts?kind=reel&singlePhotos=true`, `feed` defaulting to `all`), never the client.
 * Opened from a reel it follows that reel; opened from the CanaReels icon beside the feed's tabs it
 * starts at the newest (docs/wiki/frontend/modules/reels.md, "The CanaReels entry").
 */

/** A page of reels from `offset`, `limit` long - what `ReelViewer` asks for. */
export type ReelPageLoader = (offset: number, limit: number) => Promise<PostEntity[]>;

/** How many reels one page asks for: the viewer's page, and the entry's first read. */
export const REEL_PAGE = 10;

/** The C7 list. */
export const listAllReels: ReelPageLoader = (offset, limit) =>
  listPosts({ kind: 'reel', singlePhotos: true, feed: 'all', offset, limit });

/**
 * The C7 list, with its first page already in hand: the entry read it to know whether there is a
 * reel at all, so the viewer's first page is that one and not a second request for the same rows.
 */
export function reelsAfterFirstPage(firstPage: PostEntity[]): ReelPageLoader {
  return (offset, limit) =>
    offset === 0 && limit === REEL_PAGE ? Promise.resolve(firstPage) : listAllReels(offset, limit);
}
