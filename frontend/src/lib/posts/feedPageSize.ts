/**
 * THE FEED'S PAGE SIZES, ONE COPY (Mi 9T, v1.2.9-alpha.3).
 *
 * The cold start's `load` asked a first page of 20 while the refresh asked a scroll page of 10, and
 * both store what they get as the tab's first page: a reconnect refresh drew 10 cards and stored
 * them, and the next offline start drew those 10. Every path that asks a FIRST page asks
 * {@link FEED_FIRST_PAGE_SIZE}; only the infinite scroll asks {@link FEED_PAGE_SIZE}.
 */

/** How many posts a tab's first page holds - the cold start, the refresh, and the stored copy. */
export const FEED_FIRST_PAGE_SIZE = 20;

/** How many posts each infinite-scroll page after the first one asks for. */
export const FEED_PAGE_SIZE = 10;

/** Whether a first page this long may have more after it: a shorter one is the end. */
export function firstPageHasMore(length: number): boolean {
  return length >= FEED_FIRST_PAGE_SIZE;
}
