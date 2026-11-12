/**
 * The size of one page of posts, for the feed lists and the search alike.
 *
 * The clients ask for 10, 20 or 30 rows. Every row is a full card (media, counts, the viewer's own
 * state), so the size of a page is the cost of the request, and it is the server that sets its
 * ceiling.
 */

/** The largest page of posts one request reads. */
export const POST_PAGE_MAX = 100;

/**
 * The page size a request is served with: `fallback` when none was asked, and never more than
 * {@link POST_PAGE_MAX}. The value arrives validated (a whole number >= 1, `PostPageQueryDto`).
 */
export function postPageLimit(asked: number | undefined, fallback: number): number {
  return Math.min(asked ?? fallback, POST_PAGE_MAX);
}
