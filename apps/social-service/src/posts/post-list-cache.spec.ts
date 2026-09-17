/// <reference types="jest" />

import { POST_LIST_CACHE_PREFIX, invalidatePostListCache } from './post-list-cache';
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
