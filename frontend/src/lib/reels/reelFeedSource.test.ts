/**
 * Where the reel viewer's next reels come from: the filtered feed's tab, read by a `publishedAt`
 * cursor from the touched reel, when the viewer was opened from the CanaReels view - every reel (C7)
 * otherwise. The cursor is what keeps the continuation right when the list moved since it was drawn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reelPageLoader, type ReelFeedSource } from './reelFeedSource';
import type { ListPostsOptions, PostEntity } from '$lib/posts/api';

/** The server's filtered list, newest first, paged by offset as `GET /api/posts` does. */
let serverList: PostEntity[] = [];
const listPosts = vi.fn((options: ListPostsOptions) =>
  Promise.resolve(
    serverList.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 30))
  )
);
vi.mock('$lib/posts/api', () => ({
  listPosts: (options: ListPostsOptions) => listPosts(options),
}));

/** A reel published `day` days into October - a larger day is newer. */
function reel(id: string, day: number): PostEntity {
  return { id, publishedAt: `2026-10-${String(day).padStart(2, '0')}T12:00:00Z` } as PostEntity;
}

beforeEach(() => {
  listPosts.mockClear();
  serverList = [];
});

const FILTERED: ReelFeedSource = { options: () => ({ feed: 'associations' }) };
const UNFILTERED: ReelFeedSource = { options: () => null };

describe('reelPageLoader', () => {
  it('opened outside the feed, or from the unfiltered feed, it lists every reel (C7)', async () => {
    await reelPageLoader(undefined, reel('r2', 5))(0, 10);
    await reelPageLoader(UNFILTERED, reel('r2', 5))(10, 10);
    expect(listPosts.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'reel', feed: 'all', offset: 0, limit: 10 },
      { kind: 'reel', feed: 'all', offset: 10, limit: 10 },
    ]);
  });

  it('continues after the touched reel on the SAME tab, filtered by the server', async () => {
    serverList = [reel('r4', 9), reel('r3', 8), reel('r2', 7), reel('r1', 6)];
    const page = await reelPageLoader(FILTERED, reel('r3', 8))(0, 10);
    expect(page.map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(listPosts.mock.calls[0][0]).toMatchObject({ feed: 'associations', kind: 'reel' });
  });

  it('reels published since the list was drawn do not shift where it continues', async () => {
    // Two new reels landed on top after the reader saw r3 third in the list.
    serverList = [reel('n2', 12), reel('n1', 11), reel('r5', 9), reel('r3', 8), reel('r2', 7)];
    const page = await reelPageLoader(FILTERED, reel('r3', 8))(0, 10);
    expect(page.map((r) => r.id)).toEqual(['r2']);
  });

  it('rows deleted above the touched reel skip nothing after it', async () => {
    serverList = [reel('r3', 8), reel('r2', 7), reel('r1', 6)];
    const page = await reelPageLoader(FILTERED, reel('r3', 8))(0, 10);
    expect(page.map((r) => r.id)).toEqual(['r2', 'r1']);
  });

  it('walks pages until it has a full one, and a short page ends the list', async () => {
    serverList = [
      ...Array.from({ length: 5 }, (_, i) => reel(`new${i}`, 20 - i)),
      reel('start', 10),
      ...Array.from({ length: 4 }, (_, i) => reel(`old${i}`, 9 - i)),
    ];
    const load = reelPageLoader(FILTERED, reel('start', 10));
    const first = await load(0, 3);
    expect(first.map((r) => r.id)).toEqual(['old0', 'old1', 'old2']);
    const second = await load(3, 3);
    expect(second.map((r) => r.id)).toEqual(['old3']);
    expect(await load(6, 3)).toEqual([]);
  });
});
