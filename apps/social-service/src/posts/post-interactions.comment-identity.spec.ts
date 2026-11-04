import type { Repository } from 'typeorm';
import { ForbiddenException } from '@nestjs/common';
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
      // The read's gate on who a comment's text may reach, proven against PostgreSQL: open here.
      mentionRecipientsOf: jest.fn((_p: unknown, _w: string, ids: string[]) =>
        Promise.resolve(ids)
      ),
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
      moderatedPostIds: () => Promise.resolve(new Set<string>()),
      mayModeratePost: jest.fn(() => Promise.resolve(false)),
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

  describe("a BDE moderator of the post, on content in an institution's or another BDE's name (owner, 2026-11-03)", () => {
    const INST = 'inst-1';
    const CLUB = 'club-1';
    /** The post's moderator, who moderates what CLUB publishes and not what INST does. */
    function moderating(comments: any[]) {
      const made = make({ ...base(), comments });
      const associations = made.associations as typeof made.associations & Record<string, unknown>;
      associations.mayModeratePost = jest.fn(() => Promise.resolve(true));
      associations.mayActOnAny = jest.fn((_u: string, _ids: string[]) =>
        Promise.resolve(new Set<string>())
      );
      associations.moderatedAssociationIds = jest.fn((_u: string, ids: string[]) =>
        Promise.resolve(new Set(ids.filter((id) => id === CLUB)))
      );
      associations.refuseModeration = jest.fn(() =>
        Promise.reject(new ForbiddenException({ code: 'MODERATION_RESERVED_TO_PLATFORM_ADMIN' }))
      );
      (made.service as any).mediaRetention = { release: jest.fn(() => Promise.resolve()) };
      return made;
    }

    it('CONTROL: deletes the comment of a club it governs, and a thread whose reply is that club', async () => {
      const { service, post } = moderating([
        { id: 'c1', userId: 'w', associationId: CLUB },
        { id: 'c2', userId: 'student' },
        { id: 'r2', userId: 'w', associationId: CLUB, parentId: 'c2' },
      ]);
      await service.deleteComment('p1', 'c1', 'bde');
      await service.deleteComment('p1', 'c2', 'bde');
      expect(post.comments).toEqual([]);
    });

    it("refuses the institution's comment with the typed reserved refusal, and deletes nothing", async () => {
      const { service, post, associations } = moderating([
        { id: 'c1', userId: 'w', associationId: INST },
      ]);
      const refusal = await service.deleteComment('p1', 'c1', 'bde').catch((e: unknown) => e);
      expect((refusal as ForbiddenException).getResponse()).toMatchObject({
        code: 'MODERATION_RESERVED_TO_PLATFORM_ADMIN',
      });
      expect((associations as any).refuseModeration).toHaveBeenCalledWith('bde', {
        kind: 'comment',
        id: 'c1',
        postId: 'p1',
      });
      expect(post.comments).toHaveLength(1);
    });

    it("deletes a student's comment whose reply is the institution's, leaving a tombstone (lead, 2026-11-04)", async () => {
      // The protected reply does not shield its parent: the parent becomes the moderation's trace,
      // the institution's reply stays in its context, the club's reply goes with the delete.
      const { service, post } = moderating([
        { id: 'c1', userId: 'student', text: 'abuse', createdAt: 't0' },
        { id: 'r1', userId: 'w', associationId: INST, parentId: 'c1' },
        { id: 'r2', userId: 'w', associationId: CLUB, parentId: 'c1' },
      ]);
      const out = await service.deleteComment('p1', 'c1', 'bde');
      const stored = post.comments as any[];
      expect(stored.map((c) => c.id)).toEqual(['c1', 'r1']);
      expect(stored[0]).toMatchObject({ text: '', removedByModeration: true });
      expect(out.removedIds).toEqual(['r2']);
      expect(out.tombstones).toEqual([
        expect.objectContaining({ id: 'c1', removedByModeration: true, canDelete: false }),
      ]);
    });

    it("the writer's own delete is not moderation: it takes the whole subtree", async () => {
      const { service, post } = moderating([
        { id: 'c1', userId: 'bde', text: 'mine' },
        { id: 'r1', userId: 'w', associationId: INST, parentId: 'c1' },
      ]);
      await service.deleteComment('p1', 'c1', 'bde');
      expect(post.comments).toEqual([]);
    });

    it('serves a liked or edited comment the same bin the route honours, replies or not (S2)', async () => {
      // `likeComment` serves ONE comment: its bin must not depend on replies the response omits.
      const { service } = moderating([
        { id: 'c1', userId: 'student', likes: [] },
        { id: 'r1', userId: 'w', associationId: INST, parentId: 'c1' },
      ]);
      const liked = (await service.likeComment('p1', 'c1', 'bde')) as any;
      expect(liked.comment).toMatchObject({ id: 'c1', canDelete: true });
      const reply = (await service.likeComment('p1', 'r1', 'bde')) as any;
      expect(reply.comment).toMatchObject({ id: 'r1', canDelete: false });
    });
  });

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
      ForbiddenException
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
      ForbiddenException
    );
  });

  describe("a comment's integrity: only its author changes its text (owner, 2026-11-02)", () => {
    const plain = { id: 'c', userId: 'writer', text: 'x' };
    const asso = { id: 'b', userId: 'writer', associationId: 'asso-1', text: 'x' };
    const refusalOf = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);

    it('refuses a moderator of the post 403 COMMENT_EDIT_AUTHOR_ONLY, and still lets it delete', async () => {
      const { service, post, associations } = make({ ...base(), comments: [{ ...plain }] });
      associations.mayModeratePost.mockResolvedValue(true);
      const refusal = await refusalOf(service.editComment('p1', 'c', 'bde-mod', 'rewritten'));
      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect((refusal as ForbiddenException).getResponse()).toMatchObject({
        code: 'COMMENT_EDIT_AUTHOR_ONLY',
      });
      expect(post.comments[0].text).toBe('x');
    });

    it('refuses the platform admin on an ordinary and on an association comment', async () => {
      const { service, post, associations } = make({
        ...base(),
        comments: [{ ...plain }, { ...asso }],
      });
      // The admin holds POST_AS_ASSO nowhere: the admin tier is not authorship.
      associations.mayActOnAny.mockResolvedValue(new Set());
      for (const id of ['c', 'b']) {
        const refusal = await refusalOf(service.editComment('p1', id, 'admin', 'rewritten', true));
        expect(refusal).toBeInstanceOf(ForbiddenException);
        expect((refusal as ForbiddenException).getResponse()).toMatchObject({
          code: 'COMMENT_EDIT_AUTHOR_ONLY',
        });
      }
      expect((post.comments as Array<{ text: string }>).map((c) => c.text)).toEqual(['x', 'x']);
    });

    it('lets the author edit, the platform admin included on their own comment', async () => {
      const { service } = make({
        ...base(),
        comments: [{ ...plain }, { ...plain, id: 'own', userId: 'admin' }],
      });
      await expect(service.editComment('p1', 'c', 'writer', 'y')).resolves.toMatchObject({
        ok: true,
      });
      await expect(service.editComment('p1', 'own', 'admin', 'y', true)).resolves.toMatchObject({
        ok: true,
      });
    });
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
