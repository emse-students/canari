import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';

/**
 * A MENTION NOTIFICATION NEVER WENT THROUGH `mustHideAnonymousAuthor` AT ALL.
 *
 * Reported by a user: an anonymous post that `@mentions` someone still tells that person the real
 * name, because `createPost` resolves and sends `actorId`/`actorName` unconditionally - the one
 * write path in this file with no anonymity check anywhere near it. Unlike a post, a notification
 * is never re-shaped per reader afterwards (`actorName` is denormalized onto the row at creation,
 * per `PostNotification`'s own docblock), so the mask has to be chosen before `createNotification`
 * is ever called, not after.
 *
 * Being MENTIONED does not carry the same leak `followed_post` does: the recipient is one of
 * however many people the post names, not a member of a small set defined by watching this one
 * author, so masking the actor here (rather than suppressing the notification, as
 * `PostAnnounceScheduler` now does for `followed_post`) does not by itself narrow anybody down.
 */
describe('PostsService.createPost mention notifications mask an anonymous author', () => {
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
    const created: Record<string, unknown>[] = [];
    const notifications = {
      resolveMentionedUserIds: () => [RECIPIENT],
      resolveActorName: jest.fn(() => Promise.resolve('Real Name')),
      createNotification: jest.fn((data: Record<string, unknown>) => {
        created.push(data);
        return Promise.resolve();
      }),
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
      notifications as unknown as PostNotificationsService
    );
    return { service, notifications, created };
  }

  it('masks the actor when the post is anonymous', async () => {
    const { service, notifications, created } = makeService();

    await service.createPost({ markdown: MARKDOWN, authorId: 'author-1', anonymous: true }, false);
    await flush();

    expect(notifications.resolveActorName).not.toHaveBeenCalled();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      recipientId: RECIPIENT,
      type: 'mention',
      actorId: '',
      actorName: 'Anonyme',
    });
  });

  it('reveals the real author when the post is not anonymous', async () => {
    const { service, created } = makeService();

    await service.createPost({ markdown: MARKDOWN, authorId: 'author-1', anonymous: false }, false);
    await flush();

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ actorId: 'author-1', actorName: 'Real Name' });
  });
});
