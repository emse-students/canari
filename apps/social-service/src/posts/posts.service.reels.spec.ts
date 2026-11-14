/**
 * `PostsService` and CanaReels: the paths where a reel is published, read, edited and deleted.
 *
 * What is pinned is what only the SERVER can guarantee about a reel it cannot see inside: the blob
 * it cites is the author's (a refusal at the door, never a reel stored on trust), the expiry is
 * stamped once from the retention constant, an expired reel is unreachable by id as well as in the
 * feed, and a reel deleted by hand takes its blobs with it - falling back to the idle clock only for
 * what the media service did not confirm gone, because the worker will never come back for a row
 * that no longer exists.
 */
import { pinnedForViewerSql } from './space-pins';
import {
  BadRequestException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { CommentIdentityService } from './comment-identity';
import type { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { PostInteractionsService } from './post-interactions.service';
import type { Post } from './entities/post.entity';
import type { RedisService } from '../common/redis/redis.service';
import type { FollowsService } from '../follows/follows.service';
import type { AssociationsService } from '../associations/associations.service';
import type { PostNotificationsService } from './post-notifications.service';
import type { PostMediaRetentionService } from './post-media-retention.service';
import type { PushService } from '../push/push.service';
import { DAY_MS, REEL_RETENTION_DAYS } from './reel.constants';
import { FULL_SCREEN_POST_SQL } from './full-screen-post-sql';
import { republishedFeedAtSql } from './republished-feed-sql';
import { derivePosterKey } from '../lives/live-poster-key';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const BLOB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMMENT_BLOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const reelBody = (extra: Record<string, unknown> = {}) => ({
  kind: 'reel',
  durationMs: 30_000,
  markdown: '',
  authorId: 'alice',
  media: [{ type: 'video', mediaId: BLOB, mimeType: 'video/mp4' }],
  ...extra,
});

function makeService(opts: {
  existing?: Partial<Post>;
  claim?: () => Promise<{ refused: string[] }>;
  purge?: () => Promise<Record<string, string>>;
  saveFails?: boolean;
  /** The `platform_config` row the reel's lifetime is read from; absent = no row (the defaults). */
  retentionRow?: Record<string, unknown>;
  /** A working page cache (MGET/SETEX over a map) - off by default, so every list reads the database. */
  cache?: Map<string, string>;
}) {
  const saved: Array<Record<string, unknown>> = [];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const postRepo = {
    create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
    save: jest.fn((post: Record<string, unknown>) => {
      if (opts.saveFails) return Promise.reject(new Error('db down'));
      saved.push(post);
      return Promise.resolve({ id: 'p1', ...post });
    }),
    findOne: jest.fn(() => Promise.resolve(opts.existing)),
    remove: jest.fn(() => Promise.resolve(opts.existing)),
    manager: {
      query: jest.fn((sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (/SELECT NOW\(\) AS now/.test(sql)) return Promise.resolve([{ now: new Date(NOW) }]);
        // The one-row visibility read (WP6b): every reader here is inside the reel's audience.
        if (sql.includes('AS visible')) return Promise.resolve([{ visible: true }]);
        if (sql.includes('FROM platform_config')) {
          return Promise.resolve(opts.retentionRow ? [opts.retentionRow] : []);
        }
        return Promise.resolve([]);
      }),
    },
  };
  const retention = {
    assertOwnMedia: jest.fn(() => Promise.resolve()),
    release: jest.fn(() => Promise.resolve()),
    claimReelFor: jest.fn(opts.claim ?? (() => Promise.resolve({ refused: [] }))),
    purgeReelBlobs: jest.fn(opts.purge ?? (() => Promise.resolve({}))),
  };
  const service = new PostsService(
    postRepo as unknown as Repository<Post>,
    {
      setex: jest.fn((key: string, _ttl: number, value: string) => {
        opts.cache?.set(key, value);
        return Promise.resolve('OK');
      }),
      ...(opts.cache
        ? {
            mget: jest.fn((...keys: string[]) =>
              Promise.resolve(keys.flat().map((k) => opts.cache!.get(k) ?? null))
            ),
          }
        : {}),
      get: jest.fn(),
      deleteByPattern: jest.fn(() => Promise.resolve(0)),
      incr: jest.fn(() => Promise.resolve(1)),
    } as unknown as RedisService,
    {} as FollowsService,
    {
      isContentModerator: () => Promise.resolve(false),
      moderatedPostIds: () => Promise.resolve(new Set<string>()),
      mayModeratePost: () => Promise.resolve(false),
      mayActOnAny: () => Promise.resolve(new Set()),
    } as unknown as AssociationsService,
    { resolveMentionedUserIds: () => [] } as unknown as PostNotificationsService,
    retention as unknown as PostMediaRetentionService
  );
  return { service, postRepo, retention, saved, queries };
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => jest.restoreAllMocks());

describe('createPost - a reel', () => {
  it('claims the blob for its AUTHOR and stamps kind, duration and one expiry from the constant', async () => {
    const { service, retention, saved } = makeService({});

    await service.createPost(reelBody(), false);

    expect(retention.claimReelFor).toHaveBeenCalledWith('alice', [BLOB]);
    expect(saved[0]).toMatchObject({ kind: 'reel', durationMs: 30_000 });
    expect((saved[0].expiresAt as Date).getTime()).toBe(NOW + REEL_RETENTION_DAYS * DAY_MS);
  });

  it('stamps the lifetime IN FORCE from platform_config, not a constant (owner, 2026-11-14)', async () => {
    const { service, saved } = makeService({
      retentionRow: {
        retention_reel_days: 30,
        retention_live_replay_days: 3,
        retention_chat_reel_days: 30,
        retention_idle_media_days: 90,
      },
    });

    await service.createPost(reelBody(), false);

    expect((saved[0].expiresAt as Date).getTime()).toBe(NOW + 30 * DAY_MS);
  });

  it('refuses the publish, and claims nothing, when the lifetime cannot be read', async () => {
    const { service, retention, saved } = makeService({
      retentionRow: {
        retention_reel_days: null,
        retention_live_replay_days: 3,
        retention_chat_reel_days: 30,
        retention_idle_media_days: 90,
      },
    });

    await expect(service.createPost(reelBody(), false)).rejects.toThrow(/retention_reel_days/);
    expect(retention.claimReelFor).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  it("refuses with 400 a blob that is not the author's - and stores nothing", async () => {
    const { service, postRepo } = makeService({
      claim: () => Promise.resolve({ refused: [BLOB] }),
    });

    await expect(service.createPost(reelBody(), false)).rejects.toBeInstanceOf(BadRequestException);
    expect(postRepo.save).not.toHaveBeenCalled();
  });

  it('answers 503, not a reel on trust, when the media service cannot confirm the claim', async () => {
    const { service, postRepo } = makeService({
      claim: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    await expect(service.createPost(reelBody(), false)).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
    expect(postRepo.save).not.toHaveBeenCalled();
  });

  it('hands the blob back to the idle clock if the row could not be saved', async () => {
    const { service, retention } = makeService({ saveFails: true });

    await expect(service.createPost(reelBody(), false)).rejects.toThrow('db down');
    expect(retention.release).toHaveBeenCalledWith([BLOB]);
  });
});

describe('createPost - an ordinary post', () => {
  it('is stamped kind post, carries no duration and no expiry, and claims nothing', async () => {
    const { service, retention, saved } = makeService({});

    await service.createPost({ markdown: 'hello', authorId: 'alice', durationMs: 9000 }, false);

    expect(retention.claimReelFor).not.toHaveBeenCalled();
    expect(saved[0].kind).toBe('post');
    expect(saved[0].durationMs).toBeUndefined();
    expect(saved[0].expiresAt).toBeUndefined();
  });
});

describe('reads exclude a reel past its month', () => {
  it('lists with the live-reel clause in EVERY feed arm, and narrows by kind when asked', async () => {
    for (const feed of ['all', 'associations', 'custom'] as const) {
      const { service, queries } = makeService({});
      await service.listPosts({ limit: 10, offset: 0, feed, kind: 'reel', viewerUserId: 'alice' });
      const feedQuery = queries.find((q) => /FROM posts/.test(q.sql) && /LIMIT \$1/.test(q.sql));
      expect(feedQuery?.sql).toContain(`posts."expiresAt" IS NULL OR posts."expiresAt" > NOW()`);
      expect(feedQuery?.sql).toContain(`posts.kind IN ('reel', 'replay')`);
    }
  });

  it('with multiMedia, reels AND the full-screen posts (a link allowed), in EVERY feed arm', async () => {
    for (const feed of ['all', 'associations', 'custom'] as const) {
      const { service, queries } = makeService({});
      await service.listPosts({
        limit: 10,
        offset: 0,
        feed,
        kind: 'reel',
        multiMedia: true,
        viewerUserId: 'alice',
      });
      const sql = queries.find((q) => /FROM posts/.test(q.sql) && /LIMIT \$1/.test(q.sql))?.sql;
      expect(sql).toContain(`posts.kind IN ('reel', 'replay') OR (posts.kind = 'post' AND`);
      expect(sql).toContain(FULL_SCREEN_POST_SQL);
      // ONE SWITCH since the floor 1.6.6: no list keeps a post with a link out any more.
      expect(sql).not.toContain(`!~* 'https?://'`);
      // The visibility of a post is still asked of every row the arm serves.
      expect(sql).toContain(`posts."expiresAt" IS NULL OR posts."expiresAt" > NOW()`);
    }
  });

  it('the CanaReels list is newest first in EVERY arm: a pin does not head it', async () => {
    for (const feed of ['all', 'associations', 'custom'] as const) {
      const { service, queries } = makeService({});
      await service.listPosts({
        limit: 10,
        offset: 0,
        feed,
        kind: 'reel',
        multiMedia: true,
        viewerUserId: 'alice',
      });
      const sql = queries.find((q) => /FROM posts/.test(q.sql) && /LIMIT \$1/.test(q.sql))?.sql;
      // The Associations feed places a carried post at its latest republication (viewer at $3).
      const at = feed === 'associations' ? republishedFeedAtSql('$3') : 'posts."publishedAt"';
      expect(sql).toContain(`ORDER BY ${at} DESC, posts.id DESC`);
      expect(sql).not.toContain('post_space_pins');
    }
  });

  it('every other list keeps its pinned posts first', async () => {
    for (const kind of [undefined, 'post'] as const) {
      const { service, queries } = makeService({});
      await service.listPosts({ limit: 10, offset: 0, feed: 'all', kind, viewerUserId: 'alice' });
      const sql = queries.find((q) => /LIMIT \$1/.test(q.sql))?.sql ?? '';
      // Pinned FOR THIS READER (WP-PIN): the viewer is the feed's last placeholder ($3 here).
      expect(sql).toContain(
        `ORDER BY ${pinnedForViewerSql('posts', '$3')} DESC, posts."publishedAt" DESC, posts.id DESC`
      );
    }
  });

  it('the retired switches turn nothing on: singlePhotos, singleMedia and withLinks are not read', async () => {
    const { service, queries } = makeService({});
    await service.listPosts({
      limit: 10,
      offset: 0,
      feed: 'all',
      kind: 'reel',
      ...({ singlePhotos: true, singleMedia: true, withLinks: true } as object),
    });
    const sql = queries.find((q) => /LIMIT \$1/.test(q.sql))?.sql ?? '';
    expect(sql).not.toContain(FULL_SCREEN_POST_SQL);
    expect(sql).toContain(`posts.kind IN ('reel', 'replay')`);
  });

  it('multiMedia means nothing without kind=reel', async () => {
    const { service, queries } = makeService({});
    await service.listPosts({ limit: 10, offset: 0, feed: 'all', multiMedia: true });
    const sql = queries.find((q) => /LIMIT \$1/.test(q.sql))?.sql ?? '';
    expect(sql).not.toContain(FULL_SCREEN_POST_SQL);
  });

  it('absent kind means both: no kind clause, but the live-reel clause stays', async () => {
    const { service, queries } = makeService({});
    await service.listPosts({ limit: 10, offset: 0, feed: 'all', viewerUserId: 'alice' });
    const sql = queries.find((q) => /LIMIT \$1/.test(q.sql))?.sql ?? '';
    expect(sql).toContain(`posts."expiresAt" > NOW()`);
    expect(sql).not.toContain(`posts.kind = 'reel'`);
    expect(sql).not.toContain(`posts.kind = 'post'`);
  });

  it('A LIVE REPLAY comes only to a client that says withReplays, in the CanaReels list with the reels, never to a removed viewer (docs/wiki/live-replays.md)', async () => {
    const { service, queries } = makeService({});
    await service.listPosts({
      limit: 10,
      offset: 0,
      feed: 'all',
      kind: 'reel',
      viewerUserId: 'alice',
    });
    const without = queries.find((q) => /LIMIT \$1/.test(q.sql))?.sql ?? '';
    // The page-wide exclusion (`AND posts.kind <> 'replay'` on its own line), never the removed-viewer term.
    expect(without).toMatch(/AND posts\.kind <> 'replay'\s*\n/);
    expect(without).not.toContain('live_removed_viewers');

    queries.length = 0;
    await service.listPosts({
      limit: 10,
      offset: 0,
      feed: 'all',
      kind: 'reel',
      viewerUserId: 'alice',
      withReplays: true,
    });
    const withThem = queries.find((q) => /LIMIT \$1/.test(q.sql))?.sql ?? '';
    expect(withThem).not.toMatch(/AND posts\.kind <> 'replay'\s*\n/);
    expect(withThem).toContain(`posts.kind IN ('reel', 'replay')`);
    expect(withThem).toContain('live_removed_viewers');
  });

  it('selects the kind, the duration and the expiry on every row it serves', async () => {
    const { service, queries } = makeService({});
    await service.listPosts({ limit: 10, offset: 0, feed: 'all' });
    expect(queries.find((q) => /LIMIT \$1/.test(q.sql))?.sql).toContain(
      'posts.kind, posts."durationMs", posts."expiresAt"'
    );
  });

  it('searches with the live-row clause too, and never finds a live replay', async () => {
    const { service, queries } = makeService({});
    await service.searchPosts('trip', 10, 0, { viewerUserId: 'alice' });
    const sql = queries.find((q) => /ILIKE/.test(q.sql))?.sql;
    expect(sql).toContain(`posts."expiresAt" IS NULL OR posts."expiresAt" > NOW()`);
    expect(sql).toContain(`posts.kind <> 'replay'`);
  });

  it('search pages and the event post pick in a TOTAL order: id breaks a publishedAt tie', async () => {
    const { service, queries } = makeService({});
    await service.searchPosts('trip', 10, 0, { viewerUserId: 'alice' });
    expect(queries.find((q) => /ILIKE/.test(q.sql))?.sql).toContain(
      `ORDER BY ${pinnedForViewerSql('posts', '$4')} DESC, posts."publishedAt" DESC, posts.id DESC`
    );
    await service.findPostLinkedToCalendarEvent('ev-1', 'alice', false);
    expect(queries.find((q) => /"linkedCalendarEventId" = \$1/.test(q.sql))?.sql).toContain(
      `ORDER BY posts."publishedAt" DESC, posts.id DESC`
    );
  });

  it('answers 404 for an expired reel by id, even to its own author', async () => {
    const { service } = makeService({
      existing: { id: 'r1', authorId: 'alice', kind: 'reel', expiresAt: new Date(NOW - 1) } as Post,
    });
    await expect(service.getById('r1', { viewerId: 'alice' })).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('answers 404 for a live replay by id to a client that did not say withReplays, and serves it to one that did', async () => {
    const replay = {
      id: 'r1',
      authorId: 'alice',
      kind: 'replay',
      durationMs: 60_000,
      expiresAt: new Date(NOW + DAY_MS),
      liveId: 'l1',
      associationId: null,
      hiddenByModeration: false,
      scheduledAt: null,
    } as unknown as Post;
    await expect(
      makeService({ existing: replay }).service.getById('r1', { viewerId: 'bob' })
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      makeService({ existing: replay }).service.getById('r1', {
        viewerId: 'bob',
        withReplays: true,
      })
    ).resolves.toMatchObject({ kind: 'replay' });
    // Past its three days, withReplays or not.
    await expect(
      makeService({
        existing: { ...replay, expiresAt: new Date(NOW - 1) } as Post,
      }).service.getById('r1', { viewerId: 'alice', withReplays: true })
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('still serves a live reel, with its three fields', async () => {
    const { service } = makeService({
      existing: {
        id: 'r1',
        authorId: 'alice',
        kind: 'reel',
        durationMs: 5000,
        expiresAt: new Date(NOW + DAY_MS),
        associationId: null,
        hiddenByModeration: false,
        scheduledAt: null,
      } as unknown as Post,
    });
    await expect(service.getById('r1', { viewerId: 'bob' })).resolves.toMatchObject({
      kind: 'reel',
      durationMs: 5000,
    });
  });
});

describe('a live replay row, as served: its cover and the server clock (docs/wiki/live-replays.md)', () => {
  const LIVE = '11111111-1111-4111-8111-111111111111';
  const KEY = 'ab'.repeat(32);
  const SERVER_NOW = new Date('2026-11-01T12:00:05Z');
  /** The facts read: the live's poster and its key (the previous, plaintext format opens as-is). */
  const answerFacts = (posterName: string | null) =>
    jest.fn((sql: string) => {
      if (sql.includes('unnest($1::uuid[])')) {
        return Promise.resolve([
          {
            liveId: LIVE,
            serverNow: SERVER_NOW,
            posterName,
            posterAgeMs: 1234,
            liveKey: KEY,
            liveKeyCiphertext: null,
            liveKeyVersion: null,
          },
        ]);
      }
      if (sql.includes('AS visible')) return Promise.resolve([{ visible: true }]);
      return Promise.resolve([]);
    });
  const replay = {
    id: 'r1',
    authorId: 'alice',
    kind: 'replay',
    durationMs: 60_000,
    expiresAt: new Date(NOW + DAY_MS),
    liveId: LIVE,
    associationId: null,
    hiddenByModeration: false,
    scheduledAt: null,
  } as unknown as Post;

  it('serves the live last preview, its POSTER key (never the live key) and serverNow by id', async () => {
    const { service, postRepo } = makeService({ existing: replay });
    postRepo.manager.query = answerFacts('poster-1');
    const served = await service.getById('r1', { viewerId: 'bob', withReplays: true });
    expect(served).toMatchObject({
      kind: 'replay',
      poster: { name: 'poster-1', ageMs: 1234 },
      posterKey: derivePosterKey(KEY, LIVE),
      serverNow: SERVER_NOW,
    });
    expect(JSON.stringify(served)).not.toContain(KEY);
  });

  it('serves no cover for a live that stored no preview, and still the clock', async () => {
    const { service, postRepo } = makeService({ existing: replay });
    postRepo.manager.query = answerFacts(null);
    await expect(
      service.getById('r1', { viewerId: 'bob', withReplays: true })
    ).resolves.toMatchObject({ poster: null, posterKey: null, serverNow: SERVER_NOW });
  });

  it('adds the facts to a listed replay AFTER the page is cached, fresh on every serve from the cache', async () => {
    const cache = new Map<string, string>();
    const { service, postRepo } = makeService({ cache });
    let listReads = 0;
    let factsAnswer: (sql: string) => Promise<any[]> = answerFacts('poster-1');
    postRepo.manager.query = jest.fn((sql: string) => {
      if (sql.includes('posts."liveId", posts."studentsOnly"')) {
        listReads++;
        return Promise.resolve([
          { id: 'r1', kind: 'replay', liveId: LIVE, authorId: 'alice', mentions: '' },
          { id: 'p2', kind: 'post', liveId: null, authorId: 'alice', mentions: '' },
        ]);
      }
      return factsAnswer(sql);
    });
    const ask = () =>
      service.listPosts({
        limit: 10,
        offset: 0,
        feed: 'all',
        viewerUserId: 'bob',
        withReplays: true,
      });

    const first = await ask();
    expect(first[0]).toMatchObject({
      liveId: LIVE,
      poster: { name: 'poster-1', ageMs: 1234 },
      posterKey: derivePosterKey(KEY, LIVE),
      serverNow: SERVER_NOW,
    });
    expect(first[1]).not.toHaveProperty('serverNow');
    expect(first[1]).not.toHaveProperty('posterKey');
    // The STORED page carries none of the facts: no clock, no cover, no key.
    expect(cache.size).toBe(1);
    const stored = [...cache.values()][0];
    expect(stored).toContain(LIVE);
    for (const word of ['serverNow', 'posterKey', '"poster"', derivePosterKey(KEY, LIVE)]) {
      expect(stored).not.toContain(word);
    }

    // Served from the cache: the list is not read again, and the clock is THIS read's.
    const later = new Date(SERVER_NOW.getTime() + 20_000);
    factsAnswer = (sql) =>
      answerFacts('poster-1')(sql).then((rows) =>
        sql.includes('unnest($1::uuid[])') ? rows.map((r) => ({ ...r, serverNow: later })) : rows
      );
    const second = await ask();
    expect(listReads).toBe(1);
    expect(second[0]).toMatchObject({ posterKey: derivePosterKey(KEY, LIVE), serverNow: later });

    // The facts read fails on a cache hit: the rows go out without cover or clock, said at ERROR,
    // and the page is neither recomputed nor failed.
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    factsAnswer = (sql) =>
      sql.includes('unnest($1::uuid[])')
        ? Promise.reject(new Error('connection reset'))
        : Promise.resolve([]);
    const third = await ask();
    expect(listReads).toBe(1);
    expect(third).toHaveLength(2);
    expect(third[0]).toMatchObject({ id: 'r1', liveId: LIVE });
    expect(third[0]).not.toHaveProperty('serverNow');
    expect(third[0]).not.toHaveProperty('posterKey');
    expect(
      errors.mock.calls.some(
        (c) => String(c[0]).includes('[LIVE_REPLAY]') && String(c[0]).includes('connection reset')
      )
    ).toBe(true);
  });

  it('reads nothing for a page without a replay', async () => {
    const { service, postRepo, queries } = makeService({});
    postRepo.manager.query = jest.fn((sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('posts."liveId", posts."studentsOnly"')) {
        return Promise.resolve([{ id: 'p2', kind: 'post', liveId: null, mentions: '' }]);
      }
      return Promise.resolve([]);
    });
    await service.listPosts({ limit: 10, offset: 0, feed: 'all', viewerUserId: 'bob' });
    expect(queries.some((q) => q.sql.includes('unnest($1::uuid[])'))).toBe(false);
  });

  it('serves no cover for a preview name without its time - never an age of 0', async () => {
    const { service, postRepo } = makeService({ existing: replay });
    const facts = answerFacts('poster-1');
    postRepo.manager.query = jest.fn((sql: string) =>
      (facts(sql) as Promise<any[]>).then((rows) =>
        sql.includes('unnest($1::uuid[])') ? rows.map((r) => ({ ...r, posterAgeMs: null })) : rows
      )
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    await expect(
      service.getById('r1', { viewerId: 'bob', withReplays: true })
    ).resolves.toMatchObject({ poster: null, posterKey: null, serverNow: SERVER_NOW });
  });
});

describe('PostInteractionsService on a dead reel', () => {
  it('refuses a reaction and a comment on a reel past its month', async () => {
    const post = {
      id: 'r1',
      kind: 'reel',
      expiresAt: new Date(NOW - 1),
      reactions: {},
      comments: [],
    };
    const repo = { findOne: jest.fn(() => Promise.resolve(post)), save: jest.fn() };
    const interactions = new PostInteractionsService(
      repo as unknown as Repository<Post>,
      {} as PostNotificationsService,
      {} as PushService,
      {} as PostMediaRetentionService,
      {} as CommentIdentityService
    );

    await expect(interactions.addReaction('r1', 'bob', 'like')).rejects.toBeInstanceOf(
      NotFoundException
    );
    await expect(
      interactions.addComment('r1', { userId: 'bob', text: 'hi' })
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe('updatePost - a reel', () => {
  const live = {
    id: 'r1',
    authorId: 'alice',
    kind: 'reel',
    markdown: 'old',
    media: [{ mediaId: BLOB }],
    expiresAt: new Date(NOW + DAY_MS),
    associationId: null,
  } as unknown as Post;

  it('changes the caption and NOTHING else - the video survives an editor that sends media: []', async () => {
    const { service, postRepo } = makeService({ existing: { ...live } });

    await expect(
      service.updatePost('r1', 'alice', { markdown: 'new', polls: [], attachedFormId: null }, false)
    ).resolves.toBeDefined();

    const stored = postRepo.save.mock.calls[0][0] as unknown as Post;
    expect(stored.markdown).toBe('new');
    expect(stored.media).toEqual([{ mediaId: BLOB }]);
  });

  it('refuses to edit the video, with 400', async () => {
    const { service, postRepo } = makeService({ existing: { ...live } });
    await expect(
      service.updatePost('r1', 'alice', { markdown: 'x', media: [{ mediaId: 'other' }] }, false)
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(postRepo.save).not.toHaveBeenCalled();
  });

  it('allows an empty caption on a reel at the service (the DTO owns text-or-media for a post)', async () => {
    const { service } = makeService({ existing: { ...live } });
    await expect(service.updatePost('r1', 'alice', { markdown: '' }, false)).resolves.toBeDefined();
  });
});

describe('updatePost - a live replay (docs/wiki/live-replays.md, review of #3248)', () => {
  const replay = {
    id: 'p1',
    authorId: 'alice',
    kind: 'replay',
    liveId: 'l1',
    markdown: 'Gala live',
    media: [],
    durationMs: 60_000,
    expiresAt: new Date(NOW + DAY_MS),
    associationId: null,
    studentsOnly: false,
  } as unknown as Post;

  it('is edited by its caption alone, as a reel: no media, poll, form, event or schedule', async () => {
    const { service, postRepo } = makeService({ existing: { ...replay } });
    await expect(
      service.updatePost('p1', 'alice', { markdown: 'x', media: [{ mediaId: 'other' }] }, false)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.updatePost(
        'p1',
        'alice',
        { markdown: 'x', scheduledAt: '2099-01-01T00:00:00Z' },
        false
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(postRepo.save).not.toHaveBeenCalled();
    await expect(
      service.updatePost('p1', 'alice', { markdown: 'new' }, false)
    ).resolves.toBeDefined();
    expect((postRepo.save.mock.calls[0][0] as unknown as Post).markdown).toBe('new');
  });

  it('refuses the "Entre etudiants" switch: a replay keeps the audience of its live (D8)', async () => {
    const { service, postRepo } = makeService({ existing: { ...replay } });
    await expect(
      service.updatePost('p1', 'alice', { markdown: 'x', studentsOnly: true }, false)
    ).rejects.toMatchObject({ response: { code: 'students_only_not_offered' } });
    expect(postRepo.save).not.toHaveBeenCalled();
  });
});

describe('deletePost - a reel deleted by hand', () => {
  const reel = {
    id: 'r1',
    authorId: 'alice',
    kind: 'reel',
    media: [{ mediaId: BLOB }],
    comments: [{ id: 'c1', userId: 'bob', media: { mediaId: COMMENT_BLOB } }],
  } as unknown as Post;

  it('deletes the blobs now, each under its own uploader, and releases nothing when all are gone', async () => {
    const { service, retention } = makeService({
      existing: reel,
      purge: () => Promise.resolve({ [BLOB]: 'deleted', [COMMENT_BLOB]: 'absent' }),
    });

    await service.deletePost('r1', 'alice', false);

    // The publisher's own delete: `author` releases the post's hold alone (D-postdelete).
    expect(retention.purgeReelBlobs).toHaveBeenCalledWith(
      [
        { mediaId: BLOB, ownerId: 'alice' },
        { mediaId: COMMENT_BLOB, ownerId: 'bob' },
      ],
      'author'
    );
    expect(retention.release).not.toHaveBeenCalled();
  });

  it("a moderator's delete purges with reason `moderation`, so a file sent to chats goes too (15.4)", async () => {
    const { service, retention } = makeService({
      existing: reel,
      purge: () => Promise.resolve({ [BLOB]: 'deleted', [COMMENT_BLOB]: 'deleted' }),
    });

    // A global admin acting on Alice's reel.
    await service.deletePost('r1', 'admin-user', true);

    expect(retention.purgeReelBlobs).toHaveBeenCalledWith(expect.any(Array), 'moderation');
  });

  it('treats a `released` file (a chat still holds it) as done: nothing goes to the idle clock', async () => {
    const { service, retention } = makeService({
      existing: reel,
      purge: () => Promise.resolve({ [BLOB]: 'released', [COMMENT_BLOB]: 'deleted' }),
    });

    await service.deletePost('r1', 'alice', false);

    expect(retention.release).not.toHaveBeenCalled();
  });

  it('releases to the idle clock exactly what the media service did not confirm gone', async () => {
    const { service, retention } = makeService({
      existing: reel,
      purge: () => Promise.resolve({ [BLOB]: 'failed', [COMMENT_BLOB]: 'refused' }),
    });

    await service.deletePost('r1', 'alice', false);

    // `refused` is a blob that was not the uploader's: left alone, NOT released.
    expect(retention.release).toHaveBeenCalledWith([BLOB]);
  });

  it('releases every blob when the media service is unreachable - the row is gone, the worker will not return', async () => {
    const { service, retention } = makeService({
      existing: reel,
      purge: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    await service.deletePost('r1', 'alice', false);

    expect(retention.release).toHaveBeenCalledWith([BLOB, COMMENT_BLOB]);
  });

  it('leaves an ordinary post on the release path it always had', async () => {
    const { service, retention } = makeService({
      existing: {
        id: 'p1',
        authorId: 'alice',
        kind: 'post',
        media: [{ mediaId: BLOB }],
        comments: [],
      } as unknown as Post,
    });
    await service.deletePost('p1', 'alice', false);
    expect(retention.purgeReelBlobs).not.toHaveBeenCalled();
    expect(retention.release).toHaveBeenCalledWith([BLOB]);
  });
});

describe('getMyReels - the expiry signal', () => {
  it('asks the DATABASE clock for both the filter and the flag, and serves its instant', async () => {
    const { service, queries } = makeService({});

    const out = await service.getMyReels('alice');

    expect(out.serverNow).toBe(new Date(NOW).toISOString());
    expect(out.warningWindowDays).toBe(7);
    const reels = queries.find((q) => /FROM posts/.test(q.sql));
    expect(reels?.sql).toContain(`"authorId" = $1 AND kind = 'reel' AND "expiresAt" > $3`);
    expect(reels?.sql).toContain('"expiringSoon"');
    // The author's id is the only identity in the query: nobody else's reels, and the same instant
    // for the filter and the flag.
    expect(reels?.params).toEqual(['alice', 7, new Date(NOW)]);
  });
});
