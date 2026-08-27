import { UnauthorizedException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { PostNotificationsService } from './post-notifications.service';

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

  /** `flagHolders` maps a user id to the associations where they hold POST_AS_ASSO. */
  function makeService(post: Partial<Post>, flagHolders: Record<string, string[]> = {}) {
    const postRepo = {
      findOne: jest.fn(() => Promise.resolve(post)),
      save: jest.fn(() => Promise.resolve({ ...post } as Post)),
      remove: jest.fn(() => Promise.resolve(undefined)),
      manager: { query: jest.fn(() => Promise.resolve([])) },
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
      findValidatedCalendarEventSummary: jest.fn(() => Promise.resolve(null)),
    };

    const service = new PostsService(
      postRepo as unknown as Repository<Post>,
      { del: jest.fn(), setex: jest.fn(), get: jest.fn() } as unknown as RedisService,
      {} as FollowsService,
      associations as unknown as AssociationsService,
      { resolveMentionedUserIds: () => [] } as unknown as PostNotificationsService
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
        UnauthorizedException
      );
    });

    it('refuses the author once the association took the flag back', async () => {
      const { service } = makeService(assoPost, {});
      await expect(service.updatePost('p1', 'officer', edit)).rejects.toThrow(
        UnauthorizedException
      );
    });

    it('deletes for an officer holding the flag', async () => {
      const { service, postRepo } = makeService(assoPost, { colleague: [ASSO] });
      await expect(service.deletePost('p1', 'colleague', false)).resolves.toEqual({ ok: true });
      expect(postRepo.remove).toHaveBeenCalled();
    });

    it('refuses the delete to everyone else', async () => {
      const { service } = makeService(assoPost, {});
      await expect(service.deletePost('p1', 'stranger', false)).rejects.toThrow(
        UnauthorizedException
      );
    });

    it('keeps a personal post to its author', async () => {
      const { service } = makeService(personalPost, { intruder: [ASSO] });
      await expect(service.updatePost('p2', 'intruder', edit)).rejects.toThrow(
        UnauthorizedException
      );
    });

    it('answers the edit with a post the editor is still told they manage', async () => {
      const { service } = makeService(assoPost, { colleague: [ASSO] });
      await expect(service.updatePost('p1', 'colleague', edit)).resolves.toMatchObject({
        canManage: true,
      });
    });
  });
});
