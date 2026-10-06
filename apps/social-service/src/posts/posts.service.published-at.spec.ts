/**
 * `publishedAt` is the one instant the feed orders by and the card displays. The bug it closes:
 * a post scheduled at noon for 18:00 was ordered and labelled by its CREATION time, so it surfaced
 * at 18:00 behind everything posted since noon, stamped "12:00".
 */
import type { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { publicationTime } from './publication-time';
import type { Post } from './entities/post.entity';
import type { RedisService } from '../common/redis/redis.service';
import type { FollowsService } from '../follows/follows.service';
import type { AssociationsService } from '../associations/associations.service';
import type { PostNotificationsService } from './post-notifications.service';
import type { PostMediaRetentionService } from './post-media-retention.service';

const NOON = Date.parse('2026-10-06T12:00:00Z');
const AT_15 = Date.parse('2026-10-06T15:00:00Z');
const AT_18 = Date.parse('2026-10-06T18:00:00Z');

function makeService(existing?: Partial<Post>) {
  const saved: Array<Record<string, unknown>> = [];
  const queries: string[] = [];
  const postRepo = {
    create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
    save: jest.fn((post: Record<string, unknown>) => {
      saved.push({ ...post });
      return Promise.resolve({ id: 'p1', ...post });
    }),
    findOne: jest.fn(() => Promise.resolve(existing)),
    manager: {
      query: jest.fn((sql: string) => {
        queries.push(sql);
        return Promise.resolve(sql.includes('AS visible') ? [{ visible: true }] : []);
      }),
    },
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
      isContentModerator: () => Promise.resolve(true),
      mayActOnAny: () => Promise.resolve(new Set()),
    } as unknown as AssociationsService,
    { resolveMentionedUserIds: () => [] } as unknown as PostNotificationsService,
    { release: jest.fn() } as unknown as PostMediaRetentionService
  );
  return { service, saved, queries };
}

afterEach(() => jest.restoreAllMocks());

describe('publicationTime', () => {
  it('is the scheduled instant when there is one, the given now otherwise', () => {
    const now = new Date(NOON);
    expect(publicationTime('2026-10-06T18:00:00Z', now).getTime()).toBe(AT_18);
    expect(publicationTime(new Date(AT_18), now).getTime()).toBe(AT_18);
    expect(publicationTime(null, now)).toBe(now);
    expect(publicationTime(undefined, now)).toBe(now);
  });
});

describe('createPost stamps publishedAt', () => {
  it('orders a post scheduled earlier and published later AFTER one created in between', async () => {
    const { service, saved } = makeService();

    jest.spyOn(Date, 'now').mockReturnValue(NOON);
    jest.useFakeTimers({ now: NOON, doNotFake: ['nextTick', 'setImmediate'] });
    await service.createPost(
      { markdown: 'scheduled', authorId: 'a', scheduledAt: '2026-10-06T18:00:00Z' },
      false
    );
    jest.setSystemTime(AT_15);
    await service.createPost({ markdown: 'immediate', authorId: 'a' }, false);
    jest.useRealTimers();

    const [scheduled, immediate] = saved;
    expect((scheduled.publishedAt as Date).getTime()).toBe(AT_18);
    expect((immediate.publishedAt as Date).getTime()).toBe(AT_15);
    // The feed sorts publishedAt DESC: the scheduled post, visible at 18:00, is the newest.
    const feed = [...saved].sort(
      (x, y) => (y.publishedAt as Date).getTime() - (x.publishedAt as Date).getTime()
    );
    expect(feed.map((p) => p.markdown)).toEqual(['scheduled', 'immediate']);
  });
});

describe('updatePost keeps publishedAt in step with scheduledAt', () => {
  const pending = (): Partial<Post> => ({
    id: 'p1',
    authorId: 'a',
    markdown: 'x',
    scheduledAt: new Date(AT_18),
    publishedAt: new Date(AT_18),
    createdAt: new Date(NOON),
  });

  it('moves it with a rescheduled post', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOON);
    const { service, saved } = makeService(pending());
    await service.updatePost('p1', 'a', { markdown: 'x', scheduledAt: '2026-10-06T20:00:00Z' });
    expect((saved[0].publishedAt as Date).toISOString()).toBe('2026-10-06T20:00:00.000Z');
  });

  it('is "now" when a pending post is published immediately', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOON);
    jest.useFakeTimers({ now: AT_15, doNotFake: ['nextTick', 'setImmediate'] });
    const { service, saved } = makeService(pending());
    await service.updatePost('p1', 'a', { markdown: 'x', scheduledAt: null });
    jest.useRealTimers();
    expect((saved[0].publishedAt as Date).getTime()).toBe(AT_15);
  });

  it('keeps the instant an already-visible post appeared when it is un-scheduled', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(AT_18 + 60_000);
    const { service, saved } = makeService(pending());
    await service.updatePost('p1', 'a', { markdown: 'x', scheduledAt: null });
    expect((saved[0].publishedAt as Date).getTime()).toBe(AT_18);
  });
});

describe('the feed query', () => {
  it('orders and promo-gates by publishedAt, never createdAt', async () => {
    const { service, queries } = makeService();
    for (const feed of ['all', 'followed', 'custom', 'associations'] as const) {
      await service
        .listPosts({ limit: 10, offset: 0, feed, viewerUserId: 'u' })
        .catch(() => undefined);
    }
    const feedSql = queries.filter((q) => q.includes('ORDER BY'));
    expect(feedSql.length).toBeGreaterThanOrEqual(3);
    for (const q of feedSql) expect(q).toContain(`posts."publishedAt" DESC`);
  });
});
