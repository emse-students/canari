/// <reference types="jest" />

import { Repository } from 'typeorm';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { PostNotificationsService } from './post-notifications.service';
import type { PostInteractionsService } from './post-interactions.service';
import type { ModerationService } from '../moderation/moderation.service';

/**
 * WHAT THE PUBLISHER IS TOLD THEY MAY DO WITH THE POST THEY HAVE JUST PUBLISHED.
 *
 * The defect this pins: the controller consults `x-global-admin` to ALLOW a post in an
 * association's name, then `createPost` stamped the response with `isGlobalAdmin` hardcoded
 * `false`. A platform admin who held no membership in that association therefore got their own
 * brand-new post back with `canManage: false` - no pencil and no bin on the card they had just
 * made - while every other path that returns a post (the feed, `getById`, the update) passed the
 * real flag and drew both. One request, one identity, answered two ways, and only the create path
 * got it wrong.
 *
 * Reported by the user on 2026-09-17, who named the cause in the asking: *"J'ai cree un post mais
 * je ne pouvais pas le supprimer (je suis admin ?)"*.
 *
 * Two halves are tested because the defect lived in the seam between them: the SERVICE must honour
 * the flag it is given, and the CONTROLLER must give it the one it already used at the gate.
 */
describe('the post a publisher gets back carries the rights they actually hold', () => {
  const ASSO = 'asso-1';

  /** `flagHolders` maps a user id to the associations where they hold POST_AS_ASSO. */
  function makeService(flagHolders: Record<string, string[]> = {}) {
    const holds = (userId: string | undefined, associationId: string) =>
      !!userId && (flagHolders[userId] ?? []).includes(associationId);

    const postRepo = {
      create: jest.fn((data: Partial<Post>) => ({ ...data })),
      save: jest.fn((post: Partial<Post>) => Promise.resolve({ id: 'p1', ...post })),
      manager: { query: jest.fn(() => Promise.resolve([])) },
    };

    const associations = {
      mayActOnAny: jest.fn((userId: string | undefined, ids: string[]) =>
        Promise.resolve(new Set(ids.filter((id) => holds(userId, id))))
      ),
      isContentModerator: jest.fn(() => Promise.resolve(false)),
      resolvePostCalendarEventLink: jest.fn(() => Promise.resolve(null)),
      findValidatedCalendarEventSummary: jest.fn(() => Promise.resolve(null)),
    };

    const service = new PostsService(
      postRepo as unknown as Repository<Post>,
      {
        del: jest.fn(),
        setex: jest.fn(),
        get: jest.fn(),
        // `invalidateListCache` sweeps the whole feed prefix through this one - absent, every
        // create logs a swept-cache warning, and a spec that prints a real warning teaches its
        // reader to skip the line that will matter next time.
        deleteByPattern: jest.fn(() => Promise.resolve(0)),
      } as unknown as RedisService,
      {} as FollowsService,
      associations as unknown as AssociationsService,
      { resolveMentionedUserIds: () => [] } as unknown as PostNotificationsService
    );
    return { service, associations };
  }

  const assoPost = { markdown: 'Barbecue de rentree', associationId: ASSO, authorId: 'admin' };

  describe('PostsService.createPost', () => {
    it('grants canManage to a platform admin with no membership - the reported defect', async () => {
      const { service } = makeService();
      await expect(service.createPost({ ...assoPost }, true)).resolves.toMatchObject({
        canManage: true,
      });
    });

    it('withholds it from the same user when they are NOT an admin, so the flag is what decides', async () => {
      const { service } = makeService();
      await expect(service.createPost({ ...assoPost }, false)).resolves.toMatchObject({
        canManage: false,
      });
    });

    it('still grants it to an officer holding POST_AS_ASSO, admin or not', async () => {
      const { service } = makeService({ officer: [ASSO] });
      await expect(
        service.createPost({ ...assoPost, authorId: 'officer' }, false)
      ).resolves.toMatchObject({ canManage: true });
    });

    it('grants canPin to the admin and never to the officer - the tiers do not merge', async () => {
      const admin = makeService();
      await expect(admin.service.createPost({ ...assoPost }, true)).resolves.toMatchObject({
        canPin: true,
      });
      const officer = makeService({ officer: [ASSO] });
      await expect(
        officer.service.createPost({ ...assoPost, authorId: 'officer' }, false)
      ).resolves.toMatchObject({ canPin: false });
    });
  });

  describe('PostsController.createPost hands the flag on', () => {
    function controller() {
      const calls: { data: Record<string, unknown>; isGlobalAdmin: unknown }[] = [];
      const service = {
        createPost: jest.fn((data: Record<string, unknown>, isGlobalAdmin: unknown) => {
          calls.push({ data, isGlobalAdmin });
          return Promise.resolve({ id: 'p1', ...data });
        }),
      };
      const associationsService = {
        canPostAs: jest.fn(() => Promise.resolve(true)),
      };
      const ctrl = new PostsController(
        service as unknown as PostsService,
        {} as PostInteractionsService,
        {} as PostNotificationsService,
        associationsService as unknown as AssociationsService,
        {} as FollowsService,
        { isUserMuted: jest.fn(() => Promise.resolve(false)) } as unknown as ModerationService
      );
      return { ctrl, calls, associationsService };
    }

    it('passes true when the header says so - the SAME value the write gate used', async () => {
      const { ctrl, calls, associationsService } = controller();
      await ctrl.createPost('admin', 'true', { markdown: 'hello', associationId: ASSO });
      expect(calls[0].isGlobalAdmin).toBe(true);
      expect(associationsService.canPostAs).toHaveBeenCalledWith('admin', ASSO, {
        isGlobalAdmin: true,
      });
    });

    it('passes false when the header is absent', async () => {
      const { ctrl, calls } = controller();
      await ctrl.createPost('officer', undefined, { markdown: 'hello', associationId: ASSO });
      expect(calls[0].isGlobalAdmin).toBe(false);
    });

    it('passes false for any value that is not the literal string "true"', async () => {
      const { ctrl, calls } = controller();
      await ctrl.createPost('someone', '1', { markdown: 'hello' });
      expect(calls[0].isGlobalAdmin).toBe(false);
    });
  });

  it('uses the flag AssociationPermissionFlag.POST_AS_ASSO and no other to resolve an officer', async () => {
    const { service, associations } = makeService({ officer: [ASSO] });
    await service.createPost({ ...assoPost, authorId: 'officer' }, false);
    expect(associations.mayActOnAny).toHaveBeenCalledWith(
      'officer',
      [ASSO],
      AssociationPermissionFlag.POST_AS_ASSO
    );
  });
});
