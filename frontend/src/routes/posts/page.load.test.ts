/**
 * `load` resolves the CanaReels filter and hands it to BOTH the first request and `feedParams` -
 * the one the next pages, the refresh and the stored copy read. A filter dropped here would draw a
 * filtered pill over an unfiltered feed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFeedKindSession, rememberFeedKind } from '$lib/posts/feedKindFilter';

const listPosts = vi.fn((_options: unknown) => Promise.resolve([]));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  listPosts: (options: unknown) => listPosts(options),
}));
vi.mock('$lib/posts/feedAudience', () => ({
  isOutsideFeedAudience: () => false,
  redirectIfNotFeedAudience: () => Promise.resolve(false),
}));
vi.mock('$lib/stores/settingsStore.svelte', () => ({
  settings: { preferredPostFeed: null },
}));

const { load } = await import('./+page');

async function run(query: string) {
  const url = new URL(`https://canari.test/posts${query}`);
  return (await (load as (e: { url: URL }) => Promise<unknown>)({ url })) as {
    feedParams: { feed: string; kind?: string };
  };
}

beforeEach(() => {
  listPosts.mockClear();
  localStorage.clear();
  resetFeedKindSession();
});

describe('posts load', () => {
  it('passes kind=reel to the first request and to feedParams', async () => {
    const data = await run('?feed=associations&kind=reel');
    expect(listPosts).toHaveBeenCalledWith(
      expect.objectContaining({ feed: 'associations', kind: 'reel', limit: 20 })
    );
    expect(data.feedParams).toMatchObject({ feed: 'associations', kind: 'reel' });
  });

  it('kind=all in the URL wins over a remembered "reel"', async () => {
    rememberFeedKind('reel');
    const data = await run('?feed=all&kind=all');
    expect(listPosts.mock.calls[0][0]).not.toHaveProperty('kind', 'reel');
    expect(data.feedParams.kind).toBeUndefined();
  });

  it('a bare address opens on the remembered choice', async () => {
    rememberFeedKind('reel');
    const data = await run('');
    expect(data.feedParams.kind).toBe('reel');
  });
});
