import type { Repository } from 'typeorm';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { PostInteractionsService } from './post-interactions.service';
import { PostsController } from './posts.controller';
import type { Post } from './entities/post.entity';
import {
  ANONYMOUS_NOTIFICATION_ACTOR_NAME,
  type PostNotificationsService,
} from './post-notifications.service';
import type { PushService } from '../push/push.service';
import type { PostMediaRetentionService } from './post-media-retention.service';
import { CommentIdentityService } from './comment-identity';
import type { AssociationsService } from '../associations/associations.service';

/**
 * WHO A COMMENT SPEAKS AS, END TO END THROUGH THE WRITE PATH: what is stored, what a notice and a
 * push say, who a reply reaches, and who may edit or delete. The masking of what is SERVED is
 * `comment-identity.spec.ts`; this is the half that decides what exists to be served.
 */
describe('PostInteractionsService - comment identity', () => {
  function make(post: Record<string, unknown>, holders: string[] = ['holder-1', 'holder-2']) {
    const created: Array<Record<string, unknown>> = [];
    const notifications = {
      createNotification: jest.fn((n: Record<string, unknown>) => {
        created.push(n);
        return Promise.resolve();
      }),
      renderMentionsForPush: jest.fn((t: string) => Promise.resolve(t)),
      resolveActorName: jest.fn(() => Promise.resolve('Real Name')),
      resolveMentionedUserIds: jest.fn(() => [] as string[]),
    };
    const push = { notifyContent: jest.fn(() => Promise.resolve()) };
    const query = jest.fn((sql: string) =>
      Promise.resolve(sql.includes('FROM associations') ? [{ name: 'BDE' }] : [])
    );
    const postRepo = {
      findOne: jest.fn(() => Promise.resolve(post)),
      save: jest.fn((p: unknown) => Promise.resolve(p)),
      manager: { query },
    };
    const associations = {
      isContentModerator: jest.fn(() => Promise.resolve(false)),
      mayActOnAny: jest.fn((_u: string, ids: string[]) => Promise.resolve(new Set(ids))),
      listFlagHolders: jest.fn(() => Promise.resolve(holders)),
    };
    const identity = new CommentIdentityService(
      associations as unknown as AssociationsService,
      postRepo as unknown as Repository<Post>
    );
    const service = new PostInteractionsService(
      postRepo as unknown as Repository<Post>,
      notifications as unknown as PostNotificationsService,
      push as unknown as PushService,
      {} as PostMediaRetentionService,
      identity
    );
    return { service, post, created, push, associations };
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const base = () => ({ id: 'p1', authorId: 'author', associationId: null, comments: [] as any[] });

  it('stores an anonymous comment with the real account and no name', async () => {
    const { service, post } = make(base());
    const { comment } = await service.addComment('p1', {
      userId: 'writer',
      text: 'hi',
      anonymous: true,
    });
    const stored = post.comments[0];
    expect(stored).toMatchObject({ userId: 'writer', anonymous: true });
    expect(stored).not.toHaveProperty('displayName');
    expect(stored).not.toHaveProperty('firstName');
    // The writer sees their own account, and the controls.
    expect(comment).toMatchObject({ userId: 'writer', canEdit: true, canDelete: true });
  });

  it('masks the notice and the push of an anonymous comment at the write', async () => {
    const { service, created, push } = make(base());
    await service.addComment('p1', { userId: 'writer', text: 'hi', anonymous: true });
    await flush();
    expect(created).toEqual([
      expect.objectContaining({
        recipientId: 'author',
        actorId: '',
        actorName: ANONYMOUS_NOTIFICATION_ACTOR_NAME,
      }),
    ]);
    expect(JSON.stringify(push.notifyContent.mock.calls)).not.toContain('Real Name');
  });

  it('stores an association comment under the association and notices in its name', async () => {
    const { service, post, created } = make(base());
    await service.addComment('p1', { userId: 'writer', text: 'hi', associationId: 'asso-1' });
    await flush();
    expect(post.comments[0]).toMatchObject({ userId: 'writer', associationId: 'asso-1' });
    expect(post.comments[0]).not.toHaveProperty('displayName');
    expect(created[0]).toMatchObject({ actorId: '', actorName: 'BDE' });
  });

  it('an association wins over anonymous', async () => {
    const { service, post } = make(base());
    await service.addComment('p1', {
      userId: 'writer',
      text: 'hi',
      associationId: 'asso-1',
      anonymous: true,
    });
    expect(post.comments[0]).not.toHaveProperty('anonymous');
  });

  it('a reply to an association comment reaches every holder of the right', async () => {
    const parent = { id: 'k', userId: 'writer', associationId: 'asso-1', text: 'x' };
    const { service, created } = make({ ...base(), authorId: null, comments: [parent] });
    await service.addComment('p1', { userId: 'replier', text: 'r', parentId: 'k' });
    await flush();
    expect(
      created
        .filter((n) => n.type === 'reply')
        .map((n) => String(n.recipientId))
        .sort((a, b) => a.localeCompare(b))
    ).toEqual(['holder-1', 'holder-2']);
  });

  it('a reply to an anonymous comment reaches the real account, who is never told by whom', async () => {
    const parent = { id: 'k', userId: 'anon-writer', anonymous: true, text: 'x' };
    const { service, created } = make({ ...base(), authorId: null, comments: [parent] });
    await service.addComment('p1', { userId: 'replier', text: 'r', parentId: 'k' });
    await flush();
    expect(created).toEqual([
      expect.objectContaining({ recipientId: 'anon-writer', type: 'reply', actorName: undefined }),
    ]);
  });

  it('only the writer may edit an anonymous comment, a holder may edit an association one', async () => {
    const anon = { id: 'a', userId: 'writer', anonymous: true, text: 'x' };
    const asso = { id: 'b', userId: 'writer', associationId: 'asso-1', text: 'x' };
    const { service } = make({ ...base(), comments: [anon, asso] });
    await expect(service.editComment('p1', 'a', 'someone', 'y')).rejects.toBeInstanceOf(
      UnauthorizedException
    );
    await expect(service.editComment('p1', 'a', 'writer', 'y')).resolves.toMatchObject({
      ok: true,
    });
    // `mayActOnAny` answers for whoever asks: this reader holds the right.
    const edited = await service.editComment('p1', 'b', 'colleague', 'z');
    expect(edited.comment).toMatchObject({ text: 'z', canEdit: true });
    expect(edited.comment).toHaveProperty('editedAt');
  });

  it('refuses an association edit to someone who does not hold the right', async () => {
    const asso = { id: 'b', userId: 'writer', associationId: 'asso-1', text: 'x' };
    const { service, associations } = make({ ...base(), comments: [asso] });
    associations.mayActOnAny.mockResolvedValue(new Set());
    await expect(service.editComment('p1', 'b', 'writer', 'z')).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });
});

describe('PostsController.addComment - the right to speak for an association', () => {
  function controller(canPostAs: boolean) {
    const interactions = { addComment: jest.fn(() => Promise.resolve({ ok: true })) };
    const service = { assertVisible: jest.fn(() => Promise.resolve()) };
    const associations = { canPostAs: jest.fn(() => Promise.resolve(canPostAs)) };
    const ctl = new PostsController(
      service as never,
      interactions as never,
      {} as never,
      associations as never,
      { isUserMuted: () => Promise.resolve(false) } as never
    );
    return { ctl, interactions };
  }

  it('refuses before writing anything when the right is missing', async () => {
    const { ctl, interactions } = controller(false);
    await expect(
      ctl.addComment('u', undefined, 'p', { text: 'x', associationId: 'a' } as never)
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(interactions.addComment).not.toHaveBeenCalled();
  });

  it('lets an anonymous comment through with no condition', async () => {
    const { ctl, interactions } = controller(false);
    await ctl.addComment('u', undefined, 'p', { text: 'x', anonymous: true } as never);
    expect(interactions.addComment).toHaveBeenCalled();
  });
});
