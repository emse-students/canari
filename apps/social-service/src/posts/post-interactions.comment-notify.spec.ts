import { Repository } from 'typeorm';
import { PostInteractionsService } from './post-interactions.service';
import { Post } from './entities/post.entity';
import { PostNotificationsService } from './post-notifications.service';
import { PushService } from '../push/push.service';
import { PostMediaRetentionService } from './post-media-retention.service';

/**
 * WHO IS TOLD ABOUT A COMMENT. The post author was skipped for any post carrying an
 * `associationId` (a guard from the first bell, 2026-05), so a comment under an association post
 * notified nobody while a reaction on the same post notified its author. The member who published
 * is the author of the row either way.
 */
describe('PostInteractionsService.addComment notifications', () => {
  function makeService(post: Record<string, unknown>) {
    const created: Array<{ recipientId: string; type: string }> = [];
    const notifications = {
      createNotification: jest.fn((n: { recipientId: string; type: string }) => {
        created.push(n);
        return Promise.resolve();
      }),
      renderMentionsForPush: jest.fn((t: string) => Promise.resolve(t)),
      resolveActorName: jest.fn(() => Promise.resolve('Actor')),
      resolveMentionedUserIds: jest.fn(() => [] as string[]),
    };
    const push = { notifyContent: jest.fn(() => Promise.resolve()) };
    const postRepo = {
      findOne: jest.fn(() => Promise.resolve(post)),
      save: jest.fn((p: unknown) => Promise.resolve(p)),
      manager: { query: jest.fn(() => Promise.resolve([])) },
    };
    const service = new PostInteractionsService(
      postRepo as unknown as Repository<Post>,
      notifications as unknown as PostNotificationsService,
      push as unknown as PushService,
      {} as PostMediaRetentionService
    );
    return { service, created };
  }

  /** The notification block is fire-and-forget: let its microtasks finish. */
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('notifies the author of an association post, as of a personal one', async () => {
    for (const associationId of [null, 'asso-1']) {
      const { service, created } = makeService({
        id: 'p1',
        authorId: 'author',
        associationId,
        comments: [],
      });
      await service.addComment('p1', { userId: 'reader', text: 'hello' });
      await flush();
      expect(created).toEqual([
        expect.objectContaining({ recipientId: 'author', type: 'comment' }),
      ]);
    }
  });

  it('never notifies the author of their own comment', async () => {
    const { service, created } = makeService({
      id: 'p1',
      authorId: 'author',
      associationId: 'asso-1',
      comments: [],
    });
    await service.addComment('p1', { userId: 'author', text: 'hello' });
    await flush();
    expect(created).toEqual([]);
  });
});
