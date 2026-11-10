import type { PostEntity } from './api';

/**
 * THE PAGE AFTER A RANKED LIST'S ROWS (Pour toi and the CanaReels viewer, owner 2026-11-10;
 * `apps/social-service/src/posts/for-you-feed.ts`). A ranked list is a SNAPSHOT the server took at
 * its first page: every row it serves names that snapshot (`feedAsOf`) and its own place in the
 * whole list (`feedPosition`). The next page is asked from the place after the last one served, of
 * the same snapshot - never from the number of rows on screen, which a row withdrawn between two
 * pages (deleted, hidden, blocked) would shift. Rows without those fields (a chronological list, or
 * an estate older than `rankedFeeds`) are paged by `fallbackOffset`, as before.
 */
export function nextListPage(
  rows: readonly PostEntity[],
  fallbackOffset: number
): { offset: number; asOf?: string } {
  let asOf: string | undefined;
  let next = -1;
  for (const row of rows) {
    if (typeof row.feedAsOf !== 'string' || typeof row.feedPosition !== 'number') continue;
    if (asOf !== undefined && row.feedAsOf !== asOf) {
      // One list on screen is one snapshot: two mean a page was appended to a list it does not
      // belong to - the defect is upstream, and the last snapshot is the one asked.
      console.warn(`[RANKED] rows of two rankings in one list (${asOf}, ${row.feedAsOf})`);
      next = -1;
    }
    asOf = row.feedAsOf;
    next = Math.max(next, row.feedPosition + 1);
  }
  return asOf === undefined ? { offset: fallbackOffset } : { offset: next, asOf };
}
