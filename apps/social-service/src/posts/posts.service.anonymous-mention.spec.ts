import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostMediaRetentionService } from './post-media-retention.service';

/**
 * WHAT `createPost` HANDS TO THE MENTION NOTICES, AND WHEN.
 *
 * The notice itself - masked for an anonymous post, gated on the read's predicate - is
 * `PostNotificationsService.notifyPostMentions`, pinned in `post-notifications.mention-gate.spec.ts`.
 * What this file pins is the write's half: the stored row (`mentions` narrowed to the author's side
 * of the review cohort) goes to it when the post is published at once, and NOT when the post has a
 * `scheduledAt` - `PostAnnounceScheduler` tells those at publication, so a scheduled post never
 * pushes its text before anyone may open it.
 */
describe('PostsService.createPost mention notifications', () => {
  const MARKDOWN = 'salut @[bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb]';
  const RECIPIENT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  /** Flushes the fire-and-forget mention task `createPost` kicks off with `void`. */
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function makeService() {
    const postRepo = {
      create: jest.fn((data: Partial<Post>) => ({ ...data })),
      save: jest.fn((post: Partial<Post>) => Promise.resolve({ id: 'p1', ...post })),
      manager: { query: jest.fn(() => Promise.resolve([])) },
    };
    const associations = {
      mayActOnAny: jest.fn(() => Promise.resolve(new Set<string>())),
      isContentModerator: jest.fn(() => Promise.resolve(false)),
    };
    const notifications = {
      resolveMentionedUserIds: () => [RECIPIENT],
      notifyPostMentions: jest.fn((_post: Post) => Promise.resolve(1)),
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
    return { service, notifications };
  }

  it('hands the saved post, its mentions stored, to the notices when it is published at once', async () => {
    const { service, notifications } = makeService();

    await service.createPost({ markdown: MARKDOWN, authorId: 'author-1', anonymous: true }, false);
    await flush();

    expect(notifications.notifyPostMentions).toHaveBeenCalledTimes(1);
    expect(notifications.notifyPostMentions.mock.calls[0][0]).toMatchObject({
      id: 'p1',
      authorId: 'author-1',
      anonymous: true,
      mentions: [RECIPIENT],
    });
  });

  it('tells nobody at the write of a scheduled post: its publication does', async () => {
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

    expect(notifications.notifyPostMentions).not.toHaveBeenCalled();
  });

  /** The review cohort (review-cohort.ts): a mention never notifies across it, either way. */
  it.each([
    ['a review account mentioning a member', 'author-1'],
    ['a member mentioning a review account', RECIPIENT],
  ])('tells nobody when %s', async (_case, cohort) => {
    const saved = process.env.SERVICE_ACCOUNT_USER_ID;
    process.env.SERVICE_ACCOUNT_USER_ID = cohort;
    try {
      const { service, notifications } = makeService();
      await service.createPost(
        { markdown: MARKDOWN, authorId: 'author-1', anonymous: false },
        false
      );
      await flush();
      expect(notifications.notifyPostMentions).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.SERVICE_ACCOUNT_USER_ID;
      else process.env.SERVICE_ACCOUNT_USER_ID = saved;
    }
  });
});
