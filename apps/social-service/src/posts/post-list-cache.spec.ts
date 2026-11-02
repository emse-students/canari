/// <reference types="jest" />

import {
  POST_LIST_CACHE_PREFIX,
  invalidatePostListCache,
  invalidatePostListCacheFor,
  postListCacheKey,
} from './post-list-cache';
import type { RedisService } from '../common/redis/redis.service';

/**
 * A DELETED POST KEPT RENDERING FOR THIRTY SECONDS, AND ONLY FOR PEOPLE WHO WERE SIGNED IN.
 *
 * The feed cache key carries the viewer, the promo filter, the formation filter, the page size and
 * the offset. `PostsService.invalidateListCache` used to delete eight LITERAL keys - `all` and
 * `associations`, four page sizes, offset 0 - and every one of them named the ANONYMOUS reader.
 * A signed-in reader's key has their own id in it, so nothing on a create, a delete, a pin or a
 * moderation hide ever touched it. The bug was invisible to a signed-out check and to every reader
 * who waited out the TTL, which is why it survived: the sweep WORKED, on the one reader nobody
 * tests as.
 *
 * These assert against the KEYS a real cache holds rather than against the call, because the old
 * implementation would have passed any "does it try to invalidate" test. What separates the two is
 * exactly which entries are gone afterwards.
 */
describe('invalidatePostListCache', () => {
  /** The shapes `listPostsCacheKey` really produces, one per reader kind and page. */
  const KEYS = [
    `${POST_LIST_CACHE_PREFIX}all:anon:-:-:30:0`,
    `${POST_LIST_CACHE_PREFIX}all:7f1e0a44:-:-:30:0`,
    `${POST_LIST_CACHE_PREFIX}all:7f1e0a44:-:-:30:30`,
    `${POST_LIST_CACHE_PREFIX}associations:0c3b9d12:2027:ICM:20:0`,
    `${POST_LIST_CACHE_PREFIX}followed:0c3b9d12:-:-:10:0`,
  ];

  /** A Redis whose SCAN is honest: it matches on the prefix, the only wildcard this caller uses. */
  function fakeRedis(store: Set<string>) {
    return {
      deleteByPattern: (match: string) => {
        const prefix = match.replace(/\*$/, '');
        const doomed = Array.from(store).filter((key) => key.startsWith(prefix));
        for (const key of doomed) store.delete(key);
        return Promise.resolve(doomed.length);
      },
    } as unknown as RedisService;
  }

  it('leaves no cached page behind, signed in or not', async () => {
    const store = new Set(KEYS);

    const deleted = await invalidatePostListCache(fakeRedis(store));

    expect(deleted).toBe(KEYS.length);
    expect([...store]).toEqual([]);
  });

  it('touches nothing outside the feed cache', async () => {
    // One neighbour per family that shares the Redis instance: a sweep that took these with it
    // would be a worse defect than the one it replaces.
    const store = new Set([...KEYS, 'posts:single:abcd', 'assoc:branding:1', 'chat:presence:x']);

    await invalidatePostListCache(fakeRedis(store));

    expect([...store].sort()).toEqual(['assoc:branding:1', 'chat:presence:x', 'posts:single:abcd']);
  });

  it('keeps the prefix both services build their keys from', () => {
    // The constant is the contract between `PostsService` (which writes the keys) and
    // `AssociationsService` (which also sweeps them). A change here without one there is the
    // divergence this module was extracted to make impossible.
    expect(POST_LIST_CACHE_PREFIX).toBe('posts:list:v2:');
  });
});

/**
 * A MEMBER REPOST USED TO THROW AWAY EVERY READER'S FEED. Its effect is bounded by a known set of
 * readers (the reposter and their accepted followers), so it drops THEIR pages, every feed and
 * page of theirs, and leaves everyone else's - asserted on the keys a real cache holds, built by
 * the one builder the feed itself uses.
 */
describe('invalidatePostListCacheFor', () => {
  const page = (viewer: string | undefined, feed = 'all', offset = 0) =>
    postListCacheKey({
      feed,
      viewerUserId: viewer,
      promo: feed === 'custom' ? 2027 : undefined,
      formation: undefined,
      limit: 20,
      offset,
      kind: feed === 'followed' ? 'reel' : undefined,
      singlePhotos: feed === 'followed',
    });

  /** A Redis whose SCAN honours the prefix glob and hands every match to the selector. */
  function fakeRedis(store: Set<string>) {
    return {
      deleteMatching: (match: string, select: (key: string) => boolean) => {
        const prefix = match.replace(/\*$/, '');
        const doomed = Array.from(store).filter((k) => k.startsWith(prefix) && select(k));
        for (const key of doomed) store.delete(key);
        return Promise.resolve(doomed.length);
      },
    } as unknown as RedisService;
  }

  it("drops every page of the named readers, and nobody else's", async () => {
    const mine = [
      page('rp'),
      page('rp', 'followed'),
      page('rp', 'associations', 20),
      page('fo', 'custom'),
    ];
    const others = [page(undefined), page('out'), page('out', 'followed'), page('rpx')];
    const store = new Set([...mine, ...others, 'posts:single:rp']);

    const dropped = await invalidatePostListCacheFor(fakeRedis(store), ['rp', 'fo']);

    expect(dropped).toBe(mine.length);
    expect([...store].sort()).toEqual([...others, 'posts:single:rp'].sort());
  });

  it('touches nothing for an empty set of readers', async () => {
    const store = new Set([page('rp')]);
    let scanned = false;
    const redis = {
      deleteMatching: () => {
        scanned = true;
        return Promise.resolve(0);
      },
    } as unknown as RedisService;
    expect(await invalidatePostListCacheFor(redis, [])).toBe(0);
    expect(scanned).toBe(false);
    expect(store.size).toBe(1);
  });

  it('builds the key the feed has always used, so a deploy orphans no live entry', () => {
    expect(page('7f1e0a44')).toBe(`${POST_LIST_CACHE_PREFIX}all:7f1e0a44:-:-:20:0:-`);
    expect(page(undefined, 'followed')).toBe(
      `${POST_LIST_CACHE_PREFIX}followed:anon:-:-:20:0:reel+photos`
    );
  });
});
