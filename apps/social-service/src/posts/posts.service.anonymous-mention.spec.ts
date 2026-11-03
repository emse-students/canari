import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostMediaRetentionService } from './post-media-retention.service';

/**
 * `createPost` STORES WHO A POST MENTIONS AND TELLS NOBODY (review of #2965).
 *
 * It used to write and push a `mention` notification, with a text preview, to everyone the post
 * named - at creation, so a SCHEDULED post told them before it was out, and without asking whether
 * they could see the post at all. The mentioned readers are now told by `PostAnnounceScheduler` at
 * the post's publication, only those who see it, an anonymous author still masked there
 * (`post-announce.scheduler.spec.ts`). What stays here is the list it stores: never the author,
 * never across the review cohort's boundary.
 */
describe('PostsService.createPost stores mentions and tells nobody', () => {
  const MARKDOWN = 'salut @[bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb]';
  const RECIPIENT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  /** Lets any fire-and-forget task `createPost` might start finish. */
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function makeService() {
    const saved: Partial<Post>[] = [];
    const postRepo = {
      create: jest.fn((data: Partial<Post>) => ({ ...data })),
      save: jest.fn((post: Partial<Post>) => {
        saved.push(post);
        return Promise.resolve({ id: 'p1', ...post });
      }),
      manager: { query: jest.fn(() => Promise.resolve([])) },
    };
    const associations = {
      mayActOnAny: jest.fn(() => Promise.resolve(new Set<string>())),
      isContentModerator: jest.fn(() => Promise.resolve(false)),
    };
    const notifications = {
      resolveMentionedUserIds: () => [RECIPIENT],
      resolveActorName: jest.fn(() => Promise.resolve('Real Name')),
      createNotification: jest.fn(() => Promise.resolve()),
      createNotifications: jest.fn(() => Promise.resolve(0)),
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
      { release: jest.fn() } as unknown as PostMediaRetentionService
    );
    return { service, notifications, saved };
  }

  it.each([true, false])(
    'stores the mention and notifies nobody (anonymous: %s)',
    async (anonymous) => {
      const { service, notifications, saved } = makeService();
      await service.createPost({ markdown: MARKDOWN, authorId: 'author-1', anonymous }, false);
      await flush();
      expect(saved[0].mentions).toEqual([RECIPIENT]);
      expect(notifications.createNotification).not.toHaveBeenCalled();
      expect(notifications.createNotifications).not.toHaveBeenCalled();
      expect(notifications.resolveActorName).not.toHaveBeenCalled();
    }
  );

  it('a scheduled post tells nobody at creation either', async () => {
    const { service, notifications } = makeService();
    await service.createPost(
      {
        markdown: MARKDOWN,
        authorId: 'author-1',
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      false
    );
    await flush();
    expect(notifications.createNotification).not.toHaveBeenCalled();
    expect(notifications.createNotifications).not.toHaveBeenCalled();
  });

  /** The review cohort (review-cohort.ts): a mention is never stored across it, either way. */
  it.each([
    ['a review account mentioning a member', 'author-1'],
    ['a member mentioning a review account', RECIPIENT],
  ])('stores no mention when %s', async (_case, cohort) => {
    const saved = process.env.SERVICE_ACCOUNT_USER_ID;
    process.env.SERVICE_ACCOUNT_USER_ID = cohort;
    try {
      const { service, saved: rows } = makeService();
      await service.createPost(
        { markdown: MARKDOWN, authorId: 'author-1', anonymous: false },
        false
      );
      await flush();
      expect(rows[0].mentions ?? []).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.SERVICE_ACCOUNT_USER_ID;
      else process.env.SERVICE_ACCOUNT_USER_ID = saved;
    }
  });
});
