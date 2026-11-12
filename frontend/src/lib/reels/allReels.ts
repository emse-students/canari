import { listPosts, type PostEntity } from '$lib/posts/api';
import { readNextPage, type ListPage } from '$lib/posts/rankedFeeds';
import { DEFAULT_REEL_ORDER, type ReelOrder } from './reelOrder';

/**
 * THE LIST THE REEL VIEWER SWIPES THROUGH (C7): every live reel the reader may see, and since
 * 2026-10-19 every post whose only content is ONE picture or ONE video (user: photos in CanaReels, as on
 * Instagram) and since 2026-11-06 every post of two to ten pictures and videos (owner: a carousel),
 * a link in its text included (owner, the same day: the caption draws it), whatever tab the feed is
 * on - the server narrows (`GET /api/posts?feed=reels&kind=reel&multiMedia=true`),
 * never the client. ONE list, no tab.
 *
 * RANKED LIKE POUR TOI (owner, 2026-11-10): `ranked=true` orders it by the same freshness and
 * popularity score, from a snapshot paged by `asOf` (`posts/rankedFeeds.ts`) - or NEWEST FIRST with
 * no ranking when the reader picks "Récents" (`reelOrder.ts`, "Nos principes" the same day). An estate older than
 * `rankedFeeds` is asked the older shape (`feed=all`, newest first), which it reads as `reels`
 * (docs/wiki/legacy-compatibility.md, "`kind=reel` on `feed=all` read as the CanaReels viewer list").
 * Opened from a reel it follows that reel; opened from the CanaReels icon beside the feed's tabs it
 * starts at the top of the list (docs/wiki/frontend/modules/reels.md, "The CanaReels entry").
 */

/** A page of reels from `offset`, `limit` long - what `ReelViewer` asks for. */
export type ReelPageLoader = (offset: number, limit: number) => Promise<PostEntity[]>;

/** How many reels one page asks for: the viewer's page, and the entry's first read. */
export const REEL_PAGE = 10;

/**
 * THE LIST THAT ENDS AT THE POST OPENED: no further page. A conversation's reel (its reels are not
 * the feed's) and a feed video opened with "Défilement infini des CanaReels" off (`infiniteReels.ts`).
 */
export const NO_FURTHER_REELS: ReelPageLoader = async () => [];

/**
 * One read of the C7 list: the first page, or the page a snapshot names. In the `recent` order
 * (`reels/reelOrder.ts`) nothing is ranked - the server's newest-first list, paged by offset - and
 * the page's shape is the estate's to say (`rankedFeeds` left to `listPosts`), never the older
 * `feed=all` shape a page with no ranking facts would otherwise be asked in.
 */
function readReels(page: ListPage & { limit: number }, order: ReelOrder): Promise<PostEntity[]> {
  if (order === 'recent') {
    return listPosts({
      kind: 'reel',
      multiMedia: true,
      feed: 'reels',
      ranked: false,
      offset: page.offset,
      limit: page.limit,
    });
  }
  return listPosts({
    kind: 'reel',
    multiMedia: true,
    feed: 'reels',
    ranked: true,
    ...page,
  });
}

/** The first page of the C7 list - the entry's read, to know whether there is a reel at all. */
export function listAllReels(
  limit = REEL_PAGE,
  order: ReelOrder = DEFAULT_REEL_ORDER
): Promise<PostEntity[]> {
  return readReels({ offset: 0, limit }, order);
}

/**
 * The C7 list for ONE viewer: it keeps the rows it served, so a later page is asked of the same
 * ranking, after the last place served, in the shape its first page was served in
 * (`readNextPage`, which also ranks anew a ranking that expired and never hands back a reel the
 * viewer already holds). With `firstPage` (the entry read it already), the viewer's first page is
 * that one and not a second request for the same rows.
 */
export function allReelsLoader(
  firstPage?: PostEntity[],
  order: ReelOrder = DEFAULT_REEL_ORDER
): ReelPageLoader {
  let served: PostEntity[] = firstPage ? [...firstPage] : [];
  const read = (page: ListPage & { limit: number }) => readReels(page, order);
  return async (offset, limit) => {
    if (offset === 0) {
      if (firstPage && limit === REEL_PAGE) return firstPage;
      const page = await read({ offset: 0, limit });
      served = [...page];
      return page;
    }
    const next = await readNextPage({ shown: served, limit, read });
    served = next.rows;
    return next.appended;
  };
}
