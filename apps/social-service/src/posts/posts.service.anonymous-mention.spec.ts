import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostMediaRetentionService } from './post-media-retention.service';

/**
 * THE WRITE STORES A POST'S MENTIONS AND TELLS NOBODY.
 *
 * `PostAnnounceScheduler` is the ONE teller (review of #2947): under its one-shot `feedNotifiedAt`
 * claim it tells them when it first publishes the post (`post-announce.scheduler.spec.ts`), and the
 * notice itself - masked for an anonymous post, gated on the read's predicate - is
 * `notifyPostMentions` (`post-notifications.mention-gate.spec.ts`). Two tellers overlapped before:
 * an edit loop (publish, schedule, un-schedule) pushed the mentions again each time, and an
 * un-scheduling after the post's date but before its sweep lost them. What this file pins is that
 * neither the create nor any edit tells anyone, and that the row carries the mentions, narrowed to
 * the author's side of the review cohort, for the sweep to read.
 */
describe('PostsService: a post write stores its mentions and tells nobody', () => {
  const MARKDOWN = 'salut @[bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb]';
  const RECIPIENT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  /** Flushes any fire-and-forget task a write might have kicked off. */
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function makeService(stored?: Partial<Post>) {
    const saved: Partial<Post>[] = [];
    const postRepo = {
      create: jest.fn((data: Partial<Post>) => ({ ...data })),
      save: jest.fn((post: Partial<Post>) => {
        saved.push({ ...post });
        return Promise.resolve({ id: 'p1', ...post });
      }),
      findOne: jest.fn(() => Promise.resolve(stored ? { ...stored } : null)),
      manager: { query: jest.fn(() => Promise.resolve([])) },
    };
    const associations = {
      mayActOnAny: jest.fn(() => Promise.resolve(new Set<string>())),
      isContentModerator: jest.fn(() => Promise.resolve(false)),
      moderatedPostIds: () => Promise.resolve(new Set<string>()),
      mayModeratePost: () => Promise.resolve(false),
    };
    const notifications = {
      resolveMentionedUserIds: () => [RECIPIENT],
      notifyPostMentions: jest.fn(() => Promise.resolve(1)),
      createNotification: jest.fn(() => Promise.resolve()),
    };
    const service = new PostsService(
      postRepo as unknown as Repository<Post>,
      {
        del: jest.fn(),
        setex: jest.fn(),
        get: jest.fn(),
        deleteByPattern: jest.fn(() => Promise.resolve(0)),
      } as unknown as RedisService,
      {} as FollowsService,
      associations as unknown as AssociationsService,
      notifications as unknown as PostNotificationsService,
      { release: jest.fn(), assertOwnMedia: jest.fn() } as unknown as PostMediaRetentionService
    );
    return { service, notifications, saved };
  }

  /** Every notification the write asked for - the sweep is the one teller, so always none. */
  const told = (notifications: ReturnType<typeof makeService>['notifications']) => [
    ...notifications.notifyPostMentions.mock.calls,
    ...notifications.createNotification.mock.calls,
  ];

  it.each([
    ['published at once', {}],
    ['scheduled', { scheduledAt: new Date(Date.now() + 86_400_000).toISOString() }],
  ])('a post %s: stores the mention, tells nobody', async (_case, extra) => {
    const { service, notifications, saved } = makeService();
    await service.createPost(
      { markdown: MARKDOWN, authorId: 'author-1', anonymous: true, ...extra },
      false
    );
    await flush();
    expect(saved[0]?.mentions).toEqual([RECIPIENT]);
    expect(told(notifications)).toEqual([]);
  });

  it('the edit loop (schedule tomorrow, then publish now, again and again) tells nobody', async () => {
    const stored = {
      id: 'p1',
      authorId: 'author-1',
      associationId: null,
      kind: 'post',
      markdown: MARKDOWN,
      scheduledAt: null,
      polls: [],
      comments: [],
    } as unknown as Partial<Post>;
    const { service, notifications } = makeService(stored);
    for (let i = 0; i < 3; i++) {
      for (const scheduledAt of [new Date(Date.now() + 86_400_000).toISOString(), null]) {
        await service.updatePost('p1', 'author-1', { markdown: MARKDOWN, scheduledAt });
      }
    }
    await flush();
    expect(told(notifications)).toEqual([]);
  });

  /** The review cohort (review-cohort.ts): a mention never crosses it, either way - not even stored. */
  it.each([
    ['a review account mentioning a member', 'author-1'],
    ['a member mentioning a review account', RECIPIENT],
  ])('stores no mention when %s', async (_case, cohort) => {
    const savedEnv = process.env.SERVICE_ACCOUNT_USER_ID;
    process.env.SERVICE_ACCOUNT_USER_ID = cohort;
    try {
      const { service, notifications, saved } = makeService();
      await service.createPost(
        { markdown: MARKDOWN, authorId: 'author-1', anonymous: false },
        false
      );
      await flush();
      expect(saved[0]?.mentions ?? []).toEqual([]);
      expect(told(notifications)).toEqual([]);
    } finally {
      if (savedEnv === undefined) delete process.env.SERVICE_ACCOUNT_USER_ID;
      else process.env.SERVICE_ACCOUNT_USER_ID = savedEnv;
    }
  });
});
