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
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
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
        return Promise.resolve([]);
      }),
    },
  };
  const retention = {
    release: jest.fn(() => Promise.resolve()),
    claimReelFor: jest.fn(opts.claim ?? (() => Promise.resolve({ refused: [] }))),
    purgeReelBlobs: jest.fn(opts.purge ?? (() => Promise.resolve({}))),
  };
  const service = new PostsService(
    postRepo as unknown as Repository<Post>,
    {
      setex: jest.fn(),
      get: jest.fn(),
      deleteByPattern: jest.fn(() => Promise.resolve(0)),
    } as unknown as RedisService,
    {} as FollowsService,
    {
      isContentModerator: () => Promise.resolve(false),
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
      expect(feedQuery?.sql).toContain(`posts.kind <> 'reel' OR posts."expiresAt" > NOW()`);
      expect(feedQuery?.sql).toContain(`posts.kind = 'reel'`);
    }
  });

  it('absent kind means both: no kind clause, but the live-reel clause stays', async () => {
    const { service, queries } = makeService({});
    await service.listPosts({ limit: 10, offset: 0, feed: 'all', viewerUserId: 'alice' });
    const sql = queries.find((q) => /LIMIT \$1/.test(q.sql))?.sql ?? '';
    expect(sql).toContain(`posts."expiresAt" > NOW()`);
    expect(sql).not.toContain(`posts.kind = 'reel'`);
    expect(sql).not.toContain(`posts.kind = 'post'`);
  });

  it('selects the kind, the duration and the expiry on every row it serves', async () => {
    const { service, queries } = makeService({});
    await service.listPosts({ limit: 10, offset: 0, feed: 'all' });
    expect(queries.find((q) => /LIMIT \$1/.test(q.sql))?.sql).toContain(
      'posts.kind, posts."durationMs", posts."expiresAt"'
    );
  });

  it('searches with the live-reel clause too', async () => {
    const { service, queries } = makeService({});
    await service.searchPosts('trip', 10, 0, { viewerUserId: 'alice' });
    expect(queries.find((q) => /ILIKE/.test(q.sql))?.sql).toContain(
      `posts.kind <> 'reel' OR posts."expiresAt" > NOW()`
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
      {} as PostMediaRetentionService
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

    expect(retention.purgeReelBlobs).toHaveBeenCalledWith([
      { mediaId: BLOB, ownerId: 'alice' },
      { mediaId: COMMENT_BLOB, ownerId: 'bob' },
    ]);
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
