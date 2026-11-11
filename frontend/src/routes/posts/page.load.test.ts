// @vitest-environment happy-dom
/**
 * THE FILTERED-FEED MODE IS GONE (user, 2026-10-16): the CanaReels entry opens the reel viewer, so
 * the feed itself is never narrowed to reels any more. A `?kind=reel` link written by the 1.2.9
 * alphas, or the choice they remembered, must draw the WHOLE feed - not a reels-only feed with no
 * control left on screen to undo it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listPosts = vi.fn((_options: unknown) => Promise.resolve([]));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  listPosts: (options: unknown) => listPosts(options),
}));
vi.mock('$lib/posts/feedAudience', () => ({
  isOutsideFeedAudience: () => false,
  redirectIfNotFeedAudience: () => Promise.resolve(false),
}));
const session = vi.hoisted(() => ({ uid: 'u1' as string | null }));
vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => session.uid }));
const ensureBlocksLoaded = vi.fn();
vi.mock('$lib/follows/followState.svelte', () => ({
  ensureBlocksLoaded: () => ensureBlocksLoaded(),
}));
vi.mock('$lib/stores/settingsStore.svelte', () => ({
  settings: { preferredPostFeed: null },
}));

const { load } = await import('./+page');

async function run(query: string) {
  const url = new URL(`https://canari.test/posts${query}`);
  return (await (load as (e: { url: URL }) => Promise<unknown>)({ url })) as {
    feedParams: Record<string, unknown>;
  };
}

beforeEach(() => {
  listPosts.mockClear();
  ensureBlocksLoaded.mockClear();
  session.uid = 'u1';
  localStorage.clear();
});

describe('posts load', () => {
  it('an old ?kind=reel link draws the whole feed', async () => {
    const data = await run('?feed=associations&kind=reel');
    expect(listPosts.mock.calls[0][0]).not.toHaveProperty('kind');
    expect(data.feedParams).toEqual({ feed: 'associations' });
  });

  it('a choice the alphas remembered is not read, and is dropped', async () => {
    localStorage.setItem('canari_post_feed_kind', 'reel');
    const data = await run('');
    expect(listPosts.mock.calls[0][0]).not.toHaveProperty('kind');
    expect(data.feedParams).not.toHaveProperty('kind');
    expect(localStorage.getItem('canari_post_feed_kind')).toBeNull();
  });

  it('asks for the blocks of the reader with the first page, not after it (C2)', async () => {
    let answerPosts!: (rows: never[]) => void;
    listPosts.mockReturnValueOnce(new Promise<never[]>((r) => (answerPosts = r)));
    const loading = run('?feed=foryou');
    await Promise.resolve();
    // The posts are still unanswered: the blocks read has left already.
    expect(listPosts).toHaveBeenCalledTimes(1);
    expect(ensureBlocksLoaded).toHaveBeenCalledTimes(1);
    answerPosts([]);
    await loading;
  });

  it('a logged-out load asks for no blocks', async () => {
    session.uid = null;
    await run('?feed=foryou');
    expect(ensureBlocksLoaded).not.toHaveBeenCalled();
  });
});
