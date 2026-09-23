import { clearFeedCache, feedCacheKey, readFeedCache, writeFeedCache } from './feedCache';
import { setCurrentUserId } from '$lib/stores/userState.svelte';
import type { PostEntity } from '$lib/posts/api';

/**
 * WHAT THE TAB CACHE MUST NOT DO, which is the only part of it worth a test.
 *
 * Holding a list is trivial. The two ways this feature turns into a defect are handing one
 * reader's feed to another, and letting one tab paint from another tab's content - both of which
 * are properties of the KEY, so that is what is asserted here.
 */
const post = (id: string) => ({ id }) as PostEntity;

describe('the feed tab cache', () => {
  beforeEach(() => {
    clearFeedCache();
    setCurrentUserId('alice');
  });

  it('gives a tab back what that tab last held', () => {
    const key = feedCacheKey({ feed: 'all' });
    writeFeedCache(key, { posts: [post('p1')], hasMore: true });
    expect(readFeedCache(key)?.posts).toEqual([post('p1')]);
  });

  it('never paints one tab from another', () => {
    writeFeedCache(feedCacheKey({ feed: 'all' }), { posts: [post('p1')], hasMore: true });
    expect(readFeedCache(feedCacheKey({ feed: 'followed' }))).toBeNull();
    expect(readFeedCache(feedCacheKey({ feed: 'all', promo: 2027 }))).toBeNull();
  });

  it('never hands one reader the feed fetched for another', () => {
    const key = feedCacheKey({ feed: 'all' });
    writeFeedCache(key, { posts: [post('p1')], hasMore: true });
    setCurrentUserId('bob');
    expect(readFeedCache(feedCacheKey({ feed: 'all' }))).toBeNull();
    // And a logout is the same thing: the id is gone, so nothing written under it is reachable.
    setCurrentUserId(null);
    expect(readFeedCache(feedCacheKey({ feed: 'all' }))).toBeNull();
  });

  it('stays bounded as filters accumulate', () => {
    for (let i = 0; i < 40; i++) {
      writeFeedCache(feedCacheKey({ feed: 'all', promo: 2000 + i }), {
        posts: [post(`p${i}`)],
        hasMore: false,
      });
    }
    expect(readFeedCache(feedCacheKey({ feed: 'all', promo: 2000 }))).toBeNull();
    expect(readFeedCache(feedCacheKey({ feed: 'all', promo: 2039 }))?.posts).toEqual([post('p39')]);
  });
});
