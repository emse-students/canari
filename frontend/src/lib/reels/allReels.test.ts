/**
 * The viewer's list: every live reel the member may see, newest first, asked of the SERVER; and,
 * opened from the CanaReels entry, the first page the entry already read is not read twice.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { PostEntity } from '$lib/posts/api';

const listPosts = vi.fn((_options: unknown) => Promise.resolve([] as PostEntity[]));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  listPosts: (options: unknown) => listPosts(options),
}));

const { REEL_PAGE, listAllReels, reelsAfterFirstPage } = await import('./allReels');

beforeEach(() => listPosts.mockClear());

it('asks the server for reels and one-photo posts across every tab', async () => {
  await listAllReels(20, REEL_PAGE);
  expect(listPosts).toHaveBeenCalledWith({
    kind: 'reel',
    singlePhotos: true,
    feed: 'all',
    offset: 20,
    limit: 10,
  });
});

it('serves the first page it was handed, then asks the server for the rest', async () => {
  const first = [{ id: 'newest' }] as PostEntity[];
  const load = reelsAfterFirstPage(first);
  expect(await load(0, REEL_PAGE)).toBe(first);
  expect(listPosts).not.toHaveBeenCalled();
  await load(REEL_PAGE, REEL_PAGE);
  expect(listPosts).toHaveBeenCalledWith({
    kind: 'reel',
    singlePhotos: true,
    feed: 'all',
    offset: 10,
    limit: 10,
  });
});
