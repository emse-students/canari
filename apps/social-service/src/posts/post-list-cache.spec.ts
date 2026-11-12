/// <reference types="jest" />

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  POST_LIST_CACHE_PREFIX,
  POST_LIST_GENERATION_KEY,
  invalidatePostListCache,
  invalidatePostListCacheFor,
  postListCacheKey,
  readPostListPage,
  writePostListPage,
} from './post-list-cache';
import type { RedisService } from '../common/redis/redis.service';
import type { SingleMediaMode } from './full-screen-post-sql';

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
      incr: () => Promise.resolve(1),
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
    expect(POST_LIST_CACHE_PREFIX).toBe('posts:list:v3:');
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
      singleMedia: feed === 'followed' ? 'carousel-links' : undefined,
    });

  /** A Redis whose SCAN honours the prefix glob and hands every match to the selector. */
  function fakeRedis(store: Set<string>) {
    return {
      incrEach: () => Promise.resolve(),
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
      incrEach: () => Promise.resolve(),
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
      `${POST_LIST_CACHE_PREFIX}followed:anon:-:-:20:0:reel+carousel-links`
    );
  });

  it('keys the pictures-only and the pictures-and-videos pages apart', () => {
    const key = (singleMedia: SingleMediaMode | undefined) =>
      postListCacheKey({
        feed: 'reels',
        viewerUserId: 'u',
        promo: undefined,
        formation: undefined,
        limit: 10,
        offset: 0,
        kind: 'reel',
        singleMedia,
      });
    expect(new Set([key(undefined), key('carousel-links')]).size).toBe(2);
    // The key every client since 1.6.6 already used: the collapse of 2026-11-11 kept it.
    expect(key('carousel-links')).toBe(
      `${POST_LIST_CACHE_PREFIX}reels:u:-:-:10:0:reel+carousel-links`
    );
  });

  it('keys a page with live replays apart, and leaves the key without them as it was', () => {
    const key = (withReplays: boolean | undefined) =>
      postListCacheKey({
        feed: 'reels',
        viewerUserId: 'u',
        promo: undefined,
        formation: undefined,
        limit: 10,
        offset: 0,
        kind: 'reel',
        singleMedia: 'carousel-links',
        withReplays,
      });
    expect(key(undefined)).toBe(`${POST_LIST_CACHE_PREFIX}reels:u:-:-:10:0:reel+carousel-links`);
    expect(key(false)).toBe(key(undefined));
    expect(key(true)).toBe(`${POST_LIST_CACHE_PREFIX}reels:u:-:-:10:0:reel+carousel-links+replays`);
  });

  it('keys two rankings and two tail cursors of one list apart (for-you-feed.ts)', () => {
    const key = (asOf?: string, cursor?: string) =>
      postListCacheKey({
        feed: 'foryou',
        viewerUserId: 'u',
        promo: undefined,
        formation: undefined,
        limit: 10,
        offset: 12,
        kind: undefined,
        singleMedia: undefined,
        asOf,
        cursor,
      });
    expect(key()).toBe(`${POST_LIST_CACHE_PREFIX}foryou:u:-:-:10:12:-`);
    expect(key('T1')).not.toBe(key('T2'));
    expect(key('T1', 'C1')).not.toBe(key('T1', 'C2'));
    expect(key('T1', 'C1')).not.toBe(key('T1'));
  });
});

/**
 * A SWEEP RACES THE PAGE IT IS MEANT TO DROP (review of #3010, 2026-11-04): a feed read computes its
 * page, a write (a post hidden, deleted, made "Entre étudiants") sweeps the cache, and the read then
 * STORES the page it computed before - the withdrawn audience back for a whole TTL. The generation
 * makes the outcome independent of the interleaving: these play the interleavings on a Redis that
 * really keeps values, and assert what the next read is served.
 */
describe('the feed cache generation', () => {
  /** A Redis that keeps strings and integers, with failures that can be switched on. */
  function memoryRedis() {
    const values = new Map<string, string>();
    const fail = { incr: false, sweep: false };
    const redis = {
      mget: (...keys: string[]) => Promise.resolve(keys.map((k) => values.get(k) ?? null)),
      setex: (key: string, _ttl: number, value: string) => {
        values.set(key, value);
        return Promise.resolve();
      },
      incr: (key: string) => {
        if (fail.incr) return Promise.reject(new Error('incr refused'));
        const next = Number(values.get(key) ?? '0') + 1;
        values.set(key, String(next));
        return Promise.resolve(next);
      },
      incrEach: async (keys: string[]) => {
        for (const key of keys) await redis.incr(key);
      },
      deleteByPattern: (match: string) => {
        if (fail.sweep) return Promise.reject(new Error('scan refused'));
        const prefix = match.replace(/\*$/, '');
        const doomed = [...values.keys()].filter((k) => k.startsWith(prefix));
        for (const k of doomed) values.delete(k);
        return Promise.resolve(doomed.length);
      },
      deleteMatching: () => Promise.resolve(0),
    };
    return { redis: redis as unknown as RedisService, values, fail };
  }

  const key = postListCacheKey({
    feed: 'all',
    viewerUserId: 'staff-1',
    promo: undefined,
    formation: undefined,
    limit: 20,
    offset: 0,
    kind: undefined,
    singleMedia: undefined,
  });

  it('serves a page stored under the current generation', async () => {
    const { redis } = memoryRedis();
    const { stamp } = await readPostListPage(redis, key, 'staff-1');
    await writePostListPage(redis, key, stamp, ['p1'], 30);
    expect((await readPostListPage(redis, key, 'staff-1')).page).toEqual(['p1']);
  });

  it('never serves a page computed before an invalidation and stored after it', async () => {
    const { redis } = memoryRedis();
    const before = await readPostListPage(redis, key, 'staff-1'); // the read starts
    await invalidatePostListCache(redis); // the post is made students-only meanwhile
    await writePostListPage(redis, key, before.stamp, ['the withdrawn post'], 30); // it stores late
    expect((await readPostListPage(redis, key, 'staff-1')).page).toBeUndefined();
  });

  it('leaves no stale audience when the sweep fails, because the generation moved first', async () => {
    const { redis, fail } = memoryRedis();
    const { stamp } = await readPostListPage(redis, key, 'staff-1');
    await writePostListPage(redis, key, stamp, ['the withdrawn post'], 30);
    fail.sweep = true;
    await expect(invalidatePostListCache(redis)).rejects.toThrow('scan refused');
    expect((await readPostListPage(redis, key, 'staff-1')).page).toBeUndefined();
  });

  it('throws when the generation cannot move, so the caller logs the one failure that matters', async () => {
    const { redis, fail, values } = memoryRedis();
    fail.incr = true;
    await expect(invalidatePostListCache(redis)).rejects.toThrow('incr refused');
    expect(values.has(POST_LIST_GENERATION_KEY)).toBe(false);
  });

  it("moves one reader's generation, and leaves everyone else's pages served", async () => {
    const { redis } = memoryRedis();
    const other = key.replace('staff-1', 'student-1');
    const mine = await readPostListPage(redis, key, 'staff-1');
    const theirs = await readPostListPage(redis, other, 'student-1');
    await writePostListPage(redis, key, mine.stamp, ['a'], 30);
    await writePostListPage(redis, other, theirs.stamp, ['b'], 30);
    await invalidatePostListCacheFor(redis, ['staff-1']);
    expect((await readPostListPage(redis, key, 'staff-1')).page).toBeUndefined();
    expect((await readPostListPage(redis, other, 'student-1')).page).toEqual(['b']);
  });

  it.each(['docker-compose.prod.yml', 'docker-compose.dev.yml'])(
    'its counters cannot be evicted: %s runs a volatile-* policy, which evicts only keys with a TTL',
    (file) => {
      // The counters carry no TTL on purpose (`POST_LIST_GENERATION_KEY`): under `volatile-*` that
      // makes them unevictable. An `allkeys-*` policy could reset one and re-serve a stale page.
      const compose = readFileSync(
        join(__dirname, '..', '..', '..', '..', 'infrastructure', file),
        'utf8'
      );
      expect(compose).toMatch(/"--maxmemory-policy",\s*"volatile-[a-z-]+"/);
    }
  );
});
