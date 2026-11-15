import { lockedCommentsManager } from './locked-comments.it-fixture';
import type { CommentIdentityService } from './comment-identity';
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
  function makeService(post: Record<string, unknown>, authorTold = true) {
    const created: Array<{ recipientId: string; type: string }> = [];
    const notifications = {
      createNotification: jest.fn((n: { recipientId: string; type: string }) => {
        created.push(n);
        return Promise.resolve();
      }),
      renderMentionsForPush: jest.fn((t: string) => Promise.resolve(t)),
      resolveActorName: jest.fn(() => Promise.resolve('Actor')),
      resolveMentionedUserIds: jest.fn(() => [] as string[]),
      // The read's gate on mentions, proven in `post-notifications.mention-gate.spec.ts`: open here.
      mentionRecipientsOf: jest.fn((_post: unknown, _writer: string, ids: string[]) =>
        Promise.resolve(ids)
      ),
      // The daily cap, proven in `engagement-push-cap.integration.spec.ts`: open here.
      withinPushBudget: jest.fn((_type: string, ids: string[]) => Promise.resolve(ids)),
      // The author's door, proven in `entity-author-door.integration.spec.ts`.
      postAuthorIsTold: jest.fn(() => Promise.resolve(authorTold)),
      // The post's author: ONE notification per post (owner, 2026-11-14), its alert-or-quiet claim
      // proven in `post-activity-notice.integration.spec.ts`. Here it writes the row and pushes as
      // the first comment of an unread post does (the collapse fields are that spec's).
      notifyPostActivity: jest.fn(),
    };
    const push = { notifyContent: jest.fn((..._args: unknown[]) => Promise.resolve()) };
    notifications.notifyPostActivity.mockImplementation(
      async (n: {
        recipientId: string;
        type: string;
        postId: string;
        content: (others: number) => unknown;
        pushData?: Record<string, string>;
      }) => {
        await notifications.createNotification(n);
        await push.notifyContent(n.recipientId, n.content(0), {
          type: 'social',
          postId: n.postId,
          ...n.pushData,
        });
        return { alert: true, others: 0 };
      }
    );
    const postRepo = {
      findOne: jest.fn(() => Promise.resolve(post)),
      save: jest.fn((p: unknown) => Promise.resolve(p)),
      manager: lockedCommentsManager(post as { comments?: unknown[] }),
    };
    const service = new PostInteractionsService(
      postRepo as unknown as Repository<Post>,
      notifications as unknown as PostNotificationsService,
      push as unknown as PushService,
      {} as PostMediaRetentionService,
      {
        serve: jest.fn((c: unknown[]) => Promise.resolve(c)),
        holdersOf: jest.fn(() => Promise.resolve([] as string[])),
      } as unknown as CommentIdentityService
    );
    return { service, created, push, notifications };
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

  it("tells nothing to the writer of an entity's post who no longer holds a role there, and nothing in the bell either", async () => {
    const { service, created, push, notifications } = makeService(
      { id: 'p1', authorId: 'author', associationId: 'asso-1', comments: [] },
      false
    );
    await service.addComment('p1', { userId: 'reader', text: 'hello' });
    await flush();
    expect(notifications.postAuthorIsTold).toHaveBeenCalledWith('p1');
    expect(created).toEqual([]);
    expect(push.notifyContent).not.toHaveBeenCalled();
  });

  it("a reaction tells the departed writer of an entity's post nothing either", async () => {
    const { service, created, push } = makeService(
      { id: 'p1', authorId: 'author', associationId: 'asso-1', comments: [], reactions: {} },
      false
    );
    (service as unknown as { evaluateTrend: () => void }).evaluateTrend = () => undefined;
    await service.addReaction('p1', 'reader', 'like');
    await flush();
    expect(created).toEqual([]);
    expect(push.notifyContent).not.toHaveBeenCalled();
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

  it('names the new comment in every push it sends, so a tap can open the post AT it', async () => {
    // The post author (comment), the parent's author (reply) and a mentioned reader (mention).
    const { service, push, notifications } = makeService({
      id: 'p1',
      authorId: 'author',
      associationId: null,
      comments: [{ id: 'parent', userId: 'parent-author', parentId: null }],
    });
    notifications.resolveMentionedUserIds.mockReturnValue(['mentioned']);
    const result = await service.addComment('p1', {
      userId: 'reader',
      text: 'hello',
      parentId: 'parent',
    });
    await flush();
    const commentId = (result.comment as { id: string }).id;
    const sent = push.notifyContent.mock.calls as unknown as Array<
      [string, unknown, Record<string, string>]
    >;
    expect(sent.map(([to]) => to).sort()).toEqual(['author', 'mentioned', 'parent-author']);
    for (const [, , data] of sent) {
      expect(data).toEqual({ type: 'social', postId: 'p1', commentId });
    }
    // And every bell ROW it writes names it too: how the bell tells a comment's mention from a
    // post's (migration 132, `commentBorneNotificationSql`).
    const rows = notifications.createNotification.mock.calls.map(
      ([row]: [{ type: string; commentId?: string }]) => [row.type, row.commentId]
    );
    expect(rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      ['comment', commentId],
      ['mention', commentId],
      ['reply', commentId],
    ]);
  });

  it('evaluates the campus trend only once the comment, reply and mention rows are written', async () => {
    // The order is the code's, not a race between two fire-and-forget blocks. Friends' activity
    // no longer writes a ledger row of its own (owner, 2026-11-10).
    const order: string[] = [];
    const post = {
      id: 'p1',
      authorId: 'author',
      associationId: null,
      comments: [{ id: 'parent', userId: 'parent-author', parentId: null }],
    };
    const { service, notifications } = makeService(post);
    notifications.createNotification.mockImplementation((n: { type: string }) => {
      order.push(n.type);
      return Promise.resolve();
    });
    notifications.resolveMentionedUserIds.mockReturnValue(['mentioned']);
    const manager = (service as unknown as { postRepo: { manager: { query: jest.Mock } } }).postRepo
      .manager;
    const routed = manager.query.getMockImplementation()!;
    manager.query.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO post_engagement_notices') && sql.includes("'trend'"))
        order.push('trend');
      return routed(sql, params);
    });
    await service.addComment('p1', { userId: 'reader', text: 'hello', parentId: 'parent' });
    for (let i = 0; i < 5; i++) await flush();
    expect(order).toEqual(['comment', 'reply', 'mention', 'trend']);
  });

  it('tells the post author through the per-post notice, never the daily cap; replies and mentions ask the cap (owner, 2026-11-14)', async () => {
    const { service, push, notifications } = makeService({
      id: 'p1',
      authorId: 'author',
      associationId: null,
      comments: [{ id: 'parent', userId: 'parent-author', parentId: null }],
    });
    notifications.resolveMentionedUserIds.mockReturnValue(['mentioned']);
    await service.addComment('p1', { userId: 'reader', text: 'hello', parentId: 'parent' });
    await flush();
    expect(notifications.withinPushBudget.mock.calls.map(([type]) => type).sort()).toEqual([
      'mention',
      'reply',
    ]);
    expect(notifications.notifyPostActivity).toHaveBeenCalledTimes(1);
    expect(notifications.notifyPostActivity).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: 'author', type: 'comment', postId: 'p1' })
    );
    const sent = push.notifyContent.mock.calls as unknown as Array<[string]>;
    expect(sent.map(([to]) => to).sort()).toEqual(['author', 'mentioned', 'parent-author']);
  });

  it("asks the read's gate who of the mentioned may be told, as the writer, and tells only them", async () => {
    const post = { id: 'p1', authorId: 'author', associationId: null, comments: [] };
    const { service, push, notifications } = makeService(post);
    notifications.resolveMentionedUserIds.mockReturnValue(['author', 'kept', 'dropped']);
    notifications.mentionRecipientsOf.mockImplementation((_p, _w, ids: string[]) =>
      Promise.resolve(ids.filter((id) => id !== 'dropped'))
    );
    await service.addComment('p1', { userId: 'reader', text: 'hello' });
    await flush();
    // The post author was told as such already, so the gate is asked only about the others.
    expect(notifications.mentionRecipientsOf).toHaveBeenCalledWith(
      post,
      'reader',
      ['kept', 'dropped'],
      'COMMENT'
    );
    const sent = push.notifyContent.mock.calls as unknown as Array<[string]>;
    expect(sent.map(([to]) => to).sort()).toEqual(['author', 'kept']);
  });

  it("asks the comments' gate before telling a parent's writer of a reply, and drops whom it drops", async () => {
    // A named reader whose comments are withheld (owner, 2026-11-04) wrote the parent before the
    // switch: the gate (`'COMMENT'`) drops them, so the reply's text reaches nobody it must not.
    const post = {
      id: 'p1',
      authorId: 'author',
      associationId: null,
      comments: [{ id: 'k', userId: 'withheld-reader', text: 'old' }],
    };
    const { service, push, notifications } = makeService(post);
    notifications.mentionRecipientsOf.mockImplementation((_p, _w, ids: string[]) =>
      Promise.resolve(ids.filter((id) => id !== 'withheld-reader'))
    );
    await service.addComment('p1', { userId: 'replier', text: 'r', parentId: 'k' });
    await flush();
    expect(notifications.mentionRecipientsOf).toHaveBeenCalledWith(
      post,
      'replier',
      ['withheld-reader'],
      'COMMENT'
    );
    const sent = push.notifyContent.mock.calls as unknown as Array<[string]>;
    expect(sent.map(([to]) => to)).toEqual(['author']);
  });

  it('refuses a reply to, or a like of, a moderation tombstone (409), and tells nobody', async () => {
    // S2 (second review, 2026-11-04): a reply or a like on a tombstone would be the one path
    // left to reach the moderated writer, so neither is stored and no notice is written.
    const tomb = { id: 't', parentId: null, text: '', likes: [], removedByModeration: true };
    const post = { id: 'p1', authorId: 'author', associationId: null, comments: [tomb] };
    const { service, created, push } = makeService(post);
    await expect(
      service.addComment('p1', { userId: 'reader', text: 'r', parentId: 't' })
    ).rejects.toMatchObject({ status: 409, response: { code: 'COMMENT_REMOVED_BY_MODERATION' } });
    await expect(service.likeComment('p1', 't', 'reader')).rejects.toMatchObject({
      status: 409,
      response: { code: 'COMMENT_REMOVED_BY_MODERATION' },
    });
    await flush();
    expect(post.comments).toEqual([tomb]);
    expect(created).toEqual([]);
    expect(push.notifyContent).not.toHaveBeenCalled();
  });

  /** The review cohort (review-cohort.ts): no comment notice crosses it, in either direction. */
  it.each([
    ['a review account commenting', 'reader'],
    ['a member commenting among review accounts', 'author,parent-author,mentioned'],
  ])('tells nobody across the review cohort: %s', async (_case, cohort) => {
    const saved = process.env.SERVICE_ACCOUNT_USER_ID;
    process.env.SERVICE_ACCOUNT_USER_ID = cohort;
    try {
      const { service, created, push, notifications } = makeService({
        id: 'p1',
        authorId: 'author',
        associationId: null,
        comments: [{ id: 'parent', userId: 'parent-author', parentId: null }],
      });
      notifications.resolveMentionedUserIds.mockReturnValue(['mentioned']);
      await service.addComment('p1', { userId: 'reader', text: 'hello', parentId: 'parent' });
      await flush();
      expect(created).toEqual([]);
      expect(push.notifyContent).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.SERVICE_ACCOUNT_USER_ID;
      else process.env.SERVICE_ACCOUNT_USER_ID = saved;
    }
  });
});

describe('PostInteractionsService.addReaction across the review cohort', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it.each([
    ['a review account reacting to a member', 'reader'],
    ["a member reacting to a review account's post", 'author'],
    ['nobody in the cohort: the author is told', ''],
  ])('%s', async (_case, cohort) => {
    const saved = process.env.SERVICE_ACCOUNT_USER_ID;
    process.env.SERVICE_ACCOUNT_USER_ID = cohort;
    try {
      const notifications = {
        notifyPostActivity: jest.fn(() => Promise.resolve({ alert: true, others: 0 })),
        resolveActorName: jest.fn(() => Promise.resolve('Actor')),
        withinPushBudget: jest.fn((_type: string, ids: string[]) => Promise.resolve(ids)),
        // A personal post: its author's door holds (`entity-author-door.integration.spec.ts`).
        postAuthorIsTold: jest.fn(() => Promise.resolve(true)),
      };
      const push = { notifyContent: jest.fn(() => Promise.resolve()) };
      const post = { id: 'p1', authorId: 'author', reactions: {} };
      const service = new PostInteractionsService(
        {
          findOne: jest.fn(() => Promise.resolve(post)),
          save: jest.fn((p: unknown) => Promise.resolve(p)),
          // The trend's evaluation after a reaction: no row, so nothing announced (its own
          // behaviour is proven in `campus-trend.integration.spec.ts`).
          manager: { query: jest.fn(() => Promise.resolve([])) },
        } as unknown as Repository<Post>,
        notifications as unknown as PostNotificationsService,
        push as unknown as PushService,
        {} as PostMediaRetentionService,
        {} as CommentIdentityService
      );
      await service.addReaction('p1', 'reader', 'Rire');
      await flush();
      // ONE notification per post, never the daily cap (owner, 2026-11-14).
      const told = [
        expect.objectContaining({
          recipientId: 'author',
          type: 'reaction',
          postId: 'p1',
          actorId: 'reader',
        }),
      ];
      expect(notifications.notifyPostActivity.mock.calls).toEqual(cohort === '' ? [told] : []);
      expect(notifications.withinPushBudget).not.toHaveBeenCalled();
      expect(push.notifyContent).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.SERVICE_ACCOUNT_USER_ID;
      else process.env.SERVICE_ACCOUNT_USER_ID = saved;
    }
  });
});
