/**
 * Where the reel viewer's next reels come from: the filtered feed's tab, paged from the touched
 * reel's position, when the viewer was opened from the CanaReels view - every reel (C7) otherwise.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reelPageLoader, type ReelFeedSource } from './reelFeedSource';

const listPosts = vi.fn((_options: unknown) => Promise.resolve([]));
vi.mock('$lib/posts/api', () => ({ listPosts: (options: unknown) => listPosts(options) }));

beforeEach(() => listPosts.mockClear());

function source(filtered: boolean, ids: string[]): ReelFeedSource {
  return {
    options: () => (filtered ? { feed: 'associations' } : null),
    list: () => ids.map((id) => ({ id })),
  };
}

describe('reelPageLoader', () => {
  it('opened outside the feed, it lists every reel (C7)', async () => {
    await reelPageLoader(undefined, 'r2')(0, 10);
    expect(listPosts).toHaveBeenCalledWith({ kind: 'reel', feed: 'all', offset: 0, limit: 10 });
  });

  it('opened from the unfiltered feed, it lists every reel too', async () => {
    await reelPageLoader(source(false, ['r1', 'r2']), 'r2')(0, 10);
    expect(listPosts).toHaveBeenCalledWith({ kind: 'reel', feed: 'all', offset: 0, limit: 10 });
  });

  it('opened from the CanaReels view, it pages that tab from the touched reel', async () => {
    const load = reelPageLoader(source(true, ['r1', 'r2', 'r3']), 'r2');
    await load(0, 10);
    await load(10, 10);
    expect(listPosts.mock.calls.map((c) => c[0])).toEqual([
      { feed: 'associations', kind: 'reel', offset: 1, limit: 10 },
      { feed: 'associations', kind: 'reel', offset: 11, limit: 10 },
    ]);
  });

  it('a touched reel the list does not hold starts at the top', async () => {
    await reelPageLoader(source(true, ['r1']), 'gone')(0, 10);
    expect(listPosts).toHaveBeenCalledWith({
      feed: 'associations',
      kind: 'reel',
      offset: 0,
      limit: 10,
    });
  });
});
