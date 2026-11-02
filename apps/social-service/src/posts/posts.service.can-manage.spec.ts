import { ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { PostNotificationsService } from './post-notifications.service';
import { PostMediaRetentionService } from './post-media-retention.service';

/**
 * Who may edit a post, and - just as important - who is TOLD they may.
 *
 * The defect this pins: a post published in an association's name has its `authorId` stripped from
 * every response, on purpose. The client compared `authorId` against its own user id to draw the
 * pencil, so it compared against a field that is never there: NOBODY but a global admin could edit
 * an association's post from the app, including the officer who wrote it minutes earlier. The
 * server now answers the question itself, as `canManage`, from the same predicate that guards the
 * write.
 */
describe('PostsService post management rights', () => {
  const ASSO = 'asso-1';

  /**
   * `flagHolders` maps a user id to the associations where they hold POST_AS_ASSO; `moderators`
   * lists the users holding MODERATE in a BDE whose governed spaces hold the post; `elsewhere` those
   * holding it in a BDE that does NOT govern the post (owner, 2026-11-02: MODERATE is scoped).
   */
  function makeService(
    post: Partial<Post>,
    flagHolders: Record<string, string[]> = {},
    moderators: string[] = [],
    elsewhere: string[] = []
  ) {
    const postRepo = {
      findOne: jest.fn(() => Promise.resolve(post)),
      save: jest.fn(() => Promise.resolve({ ...post } as Post)),
      remove: jest.fn(() => Promise.resolve(undefined)),
      // The one-row visibility read (WP6b) says yes: these are about rights, not audiences.
      manager: {
        query: jest.fn((sql: string) =>
          Promise.resolve(sql.includes('AS visible') ? [{ visible: true }] : [])
        ),
      },
    };

    const holds = (userId: string | undefined, associationId: string) =>
      !!userId && (flagHolders[userId] ?? []).includes(associationId);

    const associations = {
      mayAct: jest.fn((userId: string, associationId: string, flag: AssociationPermissionFlag) =>
        Promise.resolve(
          flag === AssociationPermissionFlag.POST_AS_ASSO && holds(userId, associationId)
        )
      ),
      mayActOnAny: jest.fn((userId: string | undefined, ids: string[]) =>
        Promise.resolve(new Set(ids.filter((id) => holds(userId, id))))
      ),
      isContentModerator: jest.fn((userId: string, opts?: { isGlobalAdmin?: boolean }) =>
        Promise.resolve(
          opts?.isGlobalAdmin === true || moderators.includes(userId) || elsewhere.includes(userId)
        )
      ),
      moderatedPostIds: jest.fn((userId: string | undefined, ids: string[]) =>
        Promise.resolve(new Set(userId && moderators.includes(userId) ? ids : []))
      ),
      mayModeratePost: jest.fn((userId: string | undefined) =>
        Promise.resolve(!!userId && moderators.includes(userId))
      ),
      refuseModeration: jest.fn(() =>
        Promise.reject(new ForbiddenException({ code: 'MODERATION_OUT_OF_SCOPE' }))
      ),
      findValidatedCalendarEventSummary: jest.fn(() => Promise.resolve(null)),
    };

    const service = new PostsService(
      postRepo as unknown as Repository<Post>,
      { del: jest.fn(), setex: jest.fn(), get: jest.fn() } as unknown as RedisService,
      {} as FollowsService,
      associations as unknown as AssociationsService,
      { resolveMentionedUserIds: () => [] } as unknown as PostNotificationsService,
      { release: jest.fn() } as unknown as PostMediaRetentionService
    );
    return { service, postRepo, associations };
  }

  const assoPost = {
    id: 'p1',
    authorId: 'officer',
    associationId: ASSO,
    markdown: 'Barbecue de rentree',
    hiddenByModeration: false,
    scheduledAt: null,
  } as Partial<Post>;

  const personalPost = {
    id: 'p2',
    authorId: 'someone',
    associationId: null,
    markdown: 'Hello',
    hiddenByModeration: false,
    scheduledAt: null,
  } as unknown as Partial<Post>;

  describe('canManage, as served on the post', () => {
    it('is true for an officer holding POST_AS_ASSO - the case the app could not express', async () => {
      const { service } = makeService(assoPost, { officer: [ASSO] });
      await expect(service.getById('p1', { viewerId: 'officer' })).resolves.toMatchObject({
        canManage: true,
      });
    });

    it('is true for another officer who did not write it - the post is the association speaking', async () => {
      const { service } = makeService(assoPost, { colleague: [ASSO] });
      await expect(service.getById('p1', { viewerId: 'colleague' })).resolves.toMatchObject({
        canManage: true,
      });
    });

    it('is false for a member of the association without the flag', async () => {
      const { service } = makeService(assoPost, {});
      await expect(service.getById('p1', { viewerId: 'plain-member' })).resolves.toMatchObject({
        canManage: false,
      });
    });

    it('is false for the author once the association took the flag back', async () => {
      const { service } = makeService(assoPost, {});
      await expect(service.getById('p1', { viewerId: 'officer' })).resolves.toMatchObject({
        canManage: false,
      });
    });

    it('is true for a global admin, member or not', async () => {
      const { service } = makeService(assoPost, {});
      await expect(
        service.getById('p1', { viewerId: 'admin', isGlobalAdmin: true })
      ).resolves.toMatchObject({ canManage: true });
    });

    it('is false for an anonymous reader', async () => {
      const { service } = makeService(assoPost, {});
      await expect(service.getById('p1')).resolves.toMatchObject({ canManage: false });
    });

    it('never leaks the author of an association post while answering it', async () => {
      const { service } = makeService(assoPost, { officer: [ASSO] });
      await expect(service.getById('p1', { viewerId: 'officer' })).resolves.not.toHaveProperty(
        'authorId'
      );
    });

    it('follows authorship for a personal post', async () => {
      const { service } = makeService(personalPost, {});
      await expect(service.getById('p2', { viewerId: 'someone' })).resolves.toMatchObject({
        canManage: true,
      });
      await expect(service.getById('p2', { viewerId: 'anyone-else' })).resolves.toMatchObject({
        canManage: false,
      });
    });
  });

  describe('the write guard agrees with what was served', () => {
    const edit = { markdown: 'corrected' };

    it('accepts an officer holding POST_AS_ASSO who did not write the post', async () => {
      const { service, postRepo } = makeService(assoPost, { colleague: [ASSO] });
      await service.updatePost('p1', 'colleague', edit);
      expect(postRepo.save).toHaveBeenCalled();
    });

    it('refuses a member of the association without the flag', async () => {
      const { service } = makeService(assoPost, {});
      await expect(service.updatePost('p1', 'plain-member', edit)).rejects.toThrow(
        ForbiddenException
      );
    });

    it('refuses the author once the association took the flag back', async () => {
      const { service } = makeService(assoPost, {});
      await expect(service.updatePost('p1', 'officer', edit)).rejects.toThrow(ForbiddenException);
    });

    it('deletes for an officer holding the flag', async () => {
      const { service, postRepo } = makeService(assoPost, { colleague: [ASSO] });
      await expect(service.deletePost('p1', 'colleague', false)).resolves.toEqual({ ok: true });
      expect(postRepo.remove).toHaveBeenCalled();
    });

    it('refuses the delete to everyone else', async () => {
      const { service } = makeService(assoPost, {});
      await expect(service.deletePost('p1', 'stranger', false)).rejects.toThrow(ForbiddenException);
    });

    it('keeps a personal post to its author', async () => {
      const { service } = makeService(personalPost, { intruder: [ASSO] });
      await expect(service.updatePost('p2', 'intruder', edit)).rejects.toThrow(ForbiddenException);
    });

    it('answers the edit with a post the editor is still told they manage', async () => {
      const { service } = makeService(assoPost, { colleague: [ASSO] });
      await expect(service.updatePost('p1', 'colleague', edit)).resolves.toMatchObject({
        canManage: true,
      });
    });
  });

  /**
   * The BDE moderates the posts of the spaces it governs (owner, 2026-11-02, amending the
   * 2026-08-27 request that also let it edit): it deletes, pins, unmasks and reads the anonymous
   * author there - and EDITS NOTHING, anywhere: "tout sauf changer l'integrite du post".
   */
  describe('the content moderator tier (BDE MODERATE, scoped)', () => {
    it('may delete and pin a post of its spaces, may report it, and never edit it', async () => {
      const { service } = makeService(assoPost, {}, ['bde']);
      await expect(service.getById('p1', { viewerId: 'bde' })).resolves.toMatchObject({
        canManage: true,
        canEdit: false,
        canPin: true,
        canReport: true,
      });
    });

    it('reaches a personal post of its spaces the same way', async () => {
      const { service } = makeService(personalPost, {}, ['bde']);
      await expect(service.getById('p2', { viewerId: 'bde' })).resolves.toMatchObject({
        canManage: true,
        canEdit: false,
        canPin: true,
      });
    });

    it('has its delete accepted and its edit REFUSED with the typed 403', async () => {
      const { service, postRepo } = makeService(assoPost, {}, ['bde']);
      const refusal = await service
        .updatePost('p1', 'bde', { markdown: 'corrected' })
        .catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect((refusal as ForbiddenException).getResponse()).toMatchObject({
        code: 'POST_EDIT_PUBLISHER_ONLY',
      });
      expect(postRepo.save).not.toHaveBeenCalled();
      await expect(service.deletePost('p1', 'bde', false)).resolves.toEqual({ ok: true });
    });

    it('is offered nothing on a post OUTSIDE its governed spaces', async () => {
      const { service } = makeService(personalPost, {}, [], ['bde-other']);
      await expect(service.getById('p2', { viewerId: 'bde-other' })).resolves.toMatchObject({
        canManage: false,
        canEdit: false,
        canPin: false,
      });
    });

    it('has its delete outside its scope refused with the typed 403', async () => {
      const { service, postRepo } = makeService(personalPost, {}, [], ['bde-other']);
      await expect(service.deletePost('p2', 'bde-other', false)).rejects.toMatchObject({
        response: { code: 'MODERATION_OUT_OF_SCOPE' },
      });
      expect(postRepo.remove).not.toHaveBeenCalled();
    });

    it('never reads the anonymous author outside its scope', async () => {
      const anon = { ...personalPost, id: 'p9', anonymous: true } as unknown as Partial<Post>;
      const { service } = makeService(anon, {}, [], ['bde-other']);
      await expect(service.getById('p9', { viewerId: 'bde-other' })).resolves.not.toHaveProperty(
        'authorId'
      );
    });
  });

  /**
   * A POST'S INTEGRITY: ONLY ITS AUTHOR CHANGES ITS TEXT (owner, 2026-11-02). The platform admin
   * keeps every other control and loses this one, unless they ARE the author.
   */
  describe('the platform admin edits no post but its own', () => {
    it('is refused the edit of a personal post by somebody else, with the typed 403', async () => {
      const { service, postRepo } = makeService(personalPost, {});
      const refusal = await service
        .updatePost('p2', 'admin', { markdown: 'rewritten' }, true)
        .catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect((refusal as ForbiddenException).getResponse()).toMatchObject({
        code: 'POST_EDIT_PUBLISHER_ONLY',
      });
      expect(postRepo.save).not.toHaveBeenCalled();
    });

    it('is refused the edit of an association post it does not speak for', async () => {
      const { service, postRepo } = makeService(assoPost, {});
      await expect(
        service.updatePost('p1', 'admin', { markdown: 'rewritten' }, true)
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(postRepo.save).not.toHaveBeenCalled();
    });

    it('is not offered the pencil, and keeps the bin and the pin', async () => {
      const { service } = makeService(personalPost, {});
      await expect(
        service.getById('p2', { viewerId: 'admin', isGlobalAdmin: true })
      ).resolves.toMatchObject({ canManage: true, canEdit: false, canPin: true });
    });

    it('still edits its OWN post', async () => {
      const own = { ...personalPost, authorId: 'admin' } as unknown as Partial<Post>;
      const { service, postRepo } = makeService(own, {});
      await service.updatePost('p2', 'admin', { markdown: 'mine' }, true);
      expect(postRepo.save).toHaveBeenCalled();
    });

    it('is offered the pencil on an association post it holds POST_AS_ASSO in', async () => {
      const { service } = makeService(assoPost, { admin: [ASSO] });
      await expect(
        service.getById('p1', { viewerId: 'admin', isGlobalAdmin: true })
      ).resolves.toMatchObject({ canEdit: true });
    });
  });

  describe('canPin and canReport, for everyone else', () => {
    it('withholds the pin from the association officer who published the post', async () => {
      const { service } = makeService(assoPost, { officer: [ASSO] });
      await expect(service.getById('p1', { viewerId: 'officer' })).resolves.toMatchObject({
        canPin: false,
      });
    });

    it('withholds the report from that same officer - reporting yourself means nothing', async () => {
      const { service } = makeService(assoPost, { officer: [ASSO] });
      await expect(service.getById('p1', { viewerId: 'officer' })).resolves.toMatchObject({
        canReport: false,
      });
    });

    it('offers the report to a reader with no claim on the post', async () => {
      const { service } = makeService(assoPost, {});
      await expect(service.getById('p1', { viewerId: 'reader' })).resolves.toMatchObject({
        canManage: false,
        canPin: false,
        canReport: true,
      });
    });

    it('offers nothing at all to an anonymous reader', async () => {
      const { service } = makeService(assoPost, {});
      await expect(service.getById('p1')).resolves.toMatchObject({
        canManage: false,
        canPin: false,
        canReport: false,
      });
    });

    it('gives a platform administrator every control', async () => {
      const { service } = makeService(assoPost, {});
      await expect(
        service.getById('p1', { viewerId: 'admin', isGlobalAdmin: true })
      ).resolves.toMatchObject({ canManage: true, canPin: true });
    });
  });

  /**
   * Anonymous posts (user request, 2026-09-17): a regular reader never gets `authorId` on an
   * anonymous post, a content moderator/platform admin does, and only that same tier may clear the
   * flag - `canUnmaskAnonymous` is drawn from the exact same predicate as `canPin`.
   */
  describe('anonymous posts', () => {
    const anonPost = {
      id: 'p3',
      authorId: 'someone',
      associationId: null,
      anonymous: true,
      markdown: 'Secret',
      hiddenByModeration: false,
      scheduledAt: null,
    } as unknown as Partial<Post>;

    it('strips authorId from a regular reader, but never the anonymous flag itself', async () => {
      const { service } = makeService(anonPost, {});
      const shaped = await service.getById('p3', { viewerId: 'reader' });
      expect(shaped).not.toHaveProperty('authorId');
      expect(shaped).toMatchObject({ anonymous: true });
    });

    it('strips authorId from an anonymous reader with no viewerId at all', async () => {
      const { service } = makeService(anonPost, {});
      await expect(service.getById('p3')).resolves.not.toHaveProperty('authorId');
    });

    it('keeps authorId for a content moderator', async () => {
      const { service } = makeService(anonPost, {}, ['bde']);
      await expect(service.getById('p3', { viewerId: 'bde' })).resolves.toMatchObject({
        authorId: 'someone',
      });
    });

    it('keeps authorId for a platform admin', async () => {
      const { service } = makeService(anonPost, {});
      await expect(
        service.getById('p3', { viewerId: 'admin', isGlobalAdmin: true })
      ).resolves.toMatchObject({ authorId: 'someone' });
    });

    it('keeps authorId on a NON-anonymous personal post for everyone, unaffected by this feature', async () => {
      const { service } = makeService(personalPost, {});
      await expect(service.getById('p2', { viewerId: 'reader' })).resolves.toMatchObject({
        authorId: 'someone',
      });
    });

    it("keeps authorId for the post's own author - a moderator is not the only one who may know it was them", async () => {
      // User request, 2026-09-17: "pareil pour le posteur lui-meme quand il voit son post" -
      // the author sees their own real name/avatar too, not the generic anonymous treatment.
      const { service } = makeService(anonPost, {});
      await expect(service.getById('p3', { viewerId: 'someone' })).resolves.toMatchObject({
        authorId: 'someone',
        anonymous: true,
      });
    });

    it('grants canUnmaskAnonymous to a content moderator on an anonymous post', async () => {
      const { service } = makeService(anonPost, {}, ['bde']);
      await expect(service.getById('p3', { viewerId: 'bde' })).resolves.toMatchObject({
        canUnmaskAnonymous: true,
      });
    });

    it('grants canUnmaskAnonymous to a platform admin on an anonymous post', async () => {
      const { service } = makeService(anonPost, {});
      await expect(
        service.getById('p3', { viewerId: 'admin', isGlobalAdmin: true })
      ).resolves.toMatchObject({ canUnmaskAnonymous: true });
    });

    it("withholds canUnmaskAnonymous from the post's own author", async () => {
      const { service } = makeService(anonPost, {});
      await expect(service.getById('p3', { viewerId: 'someone' })).resolves.toMatchObject({
        canUnmaskAnonymous: false,
      });
    });

    it('withholds canUnmaskAnonymous on a post that is not anonymous, even for a moderator', async () => {
      const { service } = makeService(personalPost, {}, ['bde']);
      await expect(service.getById('p2', { viewerId: 'bde' })).resolves.toMatchObject({
        canUnmaskAnonymous: false,
      });
    });
  });
});
