/**
 * The viewer's list: every live reel the member may see, RANKED (owner, 2026-11-10), asked of the
 * SERVER; a later page asked of the same ranking after the last place served; and, opened from the
 * CanaReels entry, the first page the entry already read is not read twice.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { PostEntity } from '$lib/posts/api';

const listPosts = vi.fn((_options: unknown) => Promise.resolve([] as PostEntity[]));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  listPosts: (options: unknown) => listPosts(options),
}));

const { REEL_PAGE, listAllReels, allReelsLoader } = await import('./allReels');

const BASE = { kind: 'reel', multiMedia: true, withLinks: true, feed: 'reels', ranked: true };
const row = (id: string, feedPosition?: number) =>
  ({ id, ...(feedPosition === undefined ? {} : { feedAsOf: 'T', feedPosition }) }) as PostEntity;

beforeEach(() => listPosts.mockClear());

it('asks the server for the ranked reels and media posts across every tab', async () => {
  await listAllReels();
  expect(listPosts).toHaveBeenCalledWith({ ...BASE, offset: 0, limit: REEL_PAGE });
});

it('serves the first page it was handed, then asks the same ranking after its last place', async () => {
  // Position 1 was withdrawn on the server: the next page starts after 2, not after two rows.
  const first = [row('a', 0), row('c', 2)];
  const load = allReelsLoader(first);
  expect(await load(0, REEL_PAGE)).toBe(first);
  expect(listPosts).not.toHaveBeenCalled();
  listPosts.mockResolvedValueOnce([row('d', 3)]);
  await load(2, REEL_PAGE);
  expect(listPosts).toHaveBeenLastCalledWith({
    ...BASE,
    offset: 3,
    asOf: 'T',
    rankedFeeds: true,
    limit: REEL_PAGE,
  });
  await load(3, REEL_PAGE);
  expect(listPosts).toHaveBeenLastCalledWith({
    ...BASE,
    offset: 4,
    asOf: 'T',
    rankedFeeds: true,
    limit: REEL_PAGE,
  });
});

it('a ranking gone between two pages is ranked anew, and a reel already held is not handed back', async () => {
  const load = allReelsLoader([row('a', 0), row('b', 1)]);
  const { ApiRefusalError } = await import('$lib/utils/apiRefusalError');
  const { Log } = await import('$lib/utils/Log');
  const warn = vi.spyOn(Log, 'w').mockImplementation(() => {});
  listPosts
    .mockRejectedValueOnce(new ApiRefusalError(410, 'RANKING_GONE', 'gone'))
    .mockResolvedValueOnce([
      { id: 'b', feedAsOf: 'T2', feedPosition: 0 },
      { id: 'z', feedAsOf: 'T2', feedPosition: 1 },
    ] as PostEntity[]);
  expect((await load(2, REEL_PAGE)).map((r) => r.id)).toEqual(['z']);
  expect(listPosts).toHaveBeenLastCalledWith({
    ...BASE,
    offset: 0,
    rankedFeeds: true,
    limit: REEL_PAGE,
  });
  warn.mockRestore();
});

it('an unranked answer (an older estate) is paged by the viewer count, as before', async () => {
  const load = allReelsLoader([row('a'), row('b')]);
  await load(2, REEL_PAGE);
  // In the shape its first page was served in, never a ranked page 2 of an unranked page 1.
  expect(listPosts).toHaveBeenLastCalledWith({
    ...BASE,
    offset: 2,
    rankedFeeds: false,
    limit: REEL_PAGE,
  });
});
