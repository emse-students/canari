/**
 * The page sizes themselves. That the cold start and the refresh both ASK the first page size is
 * pinned by behaviour: `routes/posts/page.load.test.ts` (20) and `page.firstDraw.svelte.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { FEED_FIRST_PAGE_SIZE, FEED_PAGE_SIZE, firstPageHasMore } from './feedPageSize';

describe('the feed page sizes', () => {
  it('a first page is larger than a scroll page, and a short first page is the end', () => {
    expect(FEED_FIRST_PAGE_SIZE).toBeGreaterThan(FEED_PAGE_SIZE);
    expect(firstPageHasMore(FEED_FIRST_PAGE_SIZE)).toBe(true);
    expect(firstPageHasMore(FEED_FIRST_PAGE_SIZE - 1)).toBe(false);
  });
});
