/**
 * One first page, whoever asks it: the cold start and the refresh share FEED_FIRST_PAGE_SIZE, so a
 * reconnect refresh no longer stores a 10-card page for the next offline start (Mi 9T, alpha.3).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FEED_FIRST_PAGE_SIZE, FEED_PAGE_SIZE, firstPageHasMore } from './feedPageSize';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('the feed page sizes', () => {
  it('a first page is larger than a scroll page, and a short first page is the end', () => {
    expect(FEED_FIRST_PAGE_SIZE).toBeGreaterThan(FEED_PAGE_SIZE);
    expect(firstPageHasMore(FEED_FIRST_PAGE_SIZE)).toBe(true);
    expect(firstPageHasMore(FEED_FIRST_PAGE_SIZE - 1)).toBe(false);
  });

  it('load and the refresh both ask FEED_FIRST_PAGE_SIZE, and no literal size is left', () => {
    const load = read('src/routes/posts/+page.ts');
    const page = read('src/routes/posts/+page.svelte');
    expect(load).toContain('limit: FEED_FIRST_PAGE_SIZE');
    expect(load).not.toMatch(/limit: \d/);
    expect(page).toMatch(/refreshFirstPage\(\{[\s\S]*?FEED_FIRST_PAGE_SIZE[\s\S]*?\}\)/);
    expect(page).not.toMatch(/PAGE_SIZE = \d/);
  });
});
