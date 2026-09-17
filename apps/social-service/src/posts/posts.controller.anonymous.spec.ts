/// <reference types="jest" />

import { PostsController } from './posts.controller';
import type { PostsService } from './posts.service';
import type { PostInteractionsService } from './post-interactions.service';
import type { PostNotificationsService } from './post-notifications.service';
import type { AssociationsService } from '../associations/associations.service';
import type { FollowsService } from '../follows/follows.service';
import type { ModerationService } from '../moderation/moderation.service';

/**
 * MUTUAL EXCLUSIVITY IS ENFORCED SERVER-SIDE, NEVER TRUSTED FROM THE CLIENT.
 *
 * `anonymous` and `associationId` express two different identities for the same post - "nobody"
 * and "the association" - and only one client-side toggle (in `CreatePostForm.svelte`) keeps them
 * apart in the ordinary case. A post published in an association's name already anonymizes its
 * author for EVERYONE, unconditionally (`PostsService.viewerCapabilities`'s own docblock) - so a
 * client that sent both would otherwise store an `anonymous` flag that means nothing (the
 * association branch strips the author regardless of it) while still granting a moderator the
 * unmask control on a post that was never meant to carry one. `createPost` forces `anonymous`
 * false whenever `associationId` is present, before anything reaches the database.
 */
describe('PostsController.createPost - anonymous/associationId precedence', () => {
  function controller(canPostAs = true) {
    const created: Record<string, unknown>[] = [];
    const service = {
      createPost: jest.fn((data: Record<string, unknown>) => {
        created.push(data);
        return Promise.resolve({ id: 'p1', ...data });
      }),
    };
    const associationsService = {
      canPostAs: jest.fn(() => Promise.resolve(canPostAs)),
    };
    const moderationService = {
      isUserMuted: jest.fn(() => Promise.resolve(false)),
    };
    const ctrl = new PostsController(
      service as unknown as PostsService,
      {} as PostInteractionsService,
      {} as PostNotificationsService,
      associationsService as unknown as AssociationsService,
      {} as FollowsService,
      moderationService as unknown as ModerationService
    );
    return { ctrl, created };
  }

  it('keeps anonymous when no association is set', async () => {
    const { ctrl, created } = controller();
    await ctrl.createPost('user1', undefined, { markdown: 'hello', anonymous: true });
    expect(created[0]).toMatchObject({ anonymous: true, authorId: 'user1' });
  });

  it('forces anonymous false when the client also sends an associationId', async () => {
    const { ctrl, created } = controller();
    await ctrl.createPost('user1', undefined, {
      markdown: 'hello',
      anonymous: true,
      associationId: 'asso-1',
    });
    expect(created[0]).toMatchObject({ anonymous: false, associationId: 'asso-1' });
  });

  it('defaults anonymous to false when the client sends neither', async () => {
    const { ctrl, created } = controller();
    await ctrl.createPost('user1', undefined, { markdown: 'hello' });
    expect(created[0]).toMatchObject({ anonymous: false });
  });
});
