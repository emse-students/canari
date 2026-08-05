import { ForbiddenException } from '@nestjs/common';
import { AssociationsController } from './associations.controller';
import { AssociationsService } from './associations.service';
import { ProductsService } from './products.service';
import { FollowsService } from '../follows/follows.service';
import { UserTagService } from '../users/user-tag.service';
import { UserProfileService } from './user-profile.service';

describe('AssociationsController cotisation config gating (D5)', () => {
  function makeController() {
    const service = {
      isAssociationSuperAdmin: jest.fn(() => Promise.resolve(false)),
      callerHasFlag: jest.fn(() => Promise.resolve(false)),
      update: jest.fn((_id: string, patch: unknown) =>
        Promise.resolve({ id: 'asso1', cotisationEnabled: false, ...(patch as object) })
      ),
    };
    const productsService = {
      provisionCotisationProduct: jest.fn(() => Promise.resolve({ id: 'prod1' })),
    };
    const followsService = {};
    const userTagService = {};
    const userProfileService = {};

    const controller = new AssociationsController(
      service as unknown as AssociationsService,
      productsService as unknown as ProductsService,
      followsService as FollowsService,
      userTagService as UserTagService,
      userProfileService as UserProfileService
    );

    return { controller, service, productsService };
  }

  it('rejects a cotisation config change from a member without MANAGE_PRODUCTS', async () => {
    const { controller, service } = makeController();

    await expect(
      controller.update('asso1', 'user1', undefined, {
        cotisationEnabled: true,
        cotisationMode: 'lifetime',
      })
    ).rejects.toThrow(ForbiddenException);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('allows a cotisation config change from a member holding MANAGE_PRODUCTS and provisions the product', async () => {
    const { controller, service, productsService } = makeController();
    service.callerHasFlag.mockResolvedValue(true);

    const result = await controller.update('asso1', 'user1', undefined, {
      cotisationEnabled: true,
      cotisationMode: 'lifetime',
    });

    expect(service.update).toHaveBeenCalled();
    expect(productsService.provisionCotisationProduct).toHaveBeenCalled();
    expect(result.cotisationEnabled).toBe(true);
  });

  it('allows a global admin to change cotisation config without a MANAGE_PRODUCTS check', async () => {
    const { controller, service, productsService } = makeController();

    await controller.update('asso1', 'user1', 'true', {
      cotisationEnabled: true,
      cotisationMode: 'dated',
    });

    expect(service.callerHasFlag).not.toHaveBeenCalled();
    expect(service.update).toHaveBeenCalled();
    expect(productsService.provisionCotisationProduct).toHaveBeenCalled();
  });

  it('does not check MANAGE_PRODUCTS for updates that do not touch cotisation fields', async () => {
    const { controller, service, productsService } = makeController();

    await controller.update('asso1', 'user1', undefined, { name: 'New name' });

    expect(service.callerHasFlag).not.toHaveBeenCalled();
    expect(service.update).toHaveBeenCalled();
    expect(productsService.provisionCotisationProduct).not.toHaveBeenCalled();
  });
});

/**
 * The three association reads all spread the entity, and none of them carries a guard, so the
 * document vault master key was reachable without a session at all.
 */
describe('AssociationsController secret stripping', () => {
  const row = {
    id: 'asso1',
    slug: 'bde',
    name: 'BDE',
    memberCount: 3,
    stripeOnboardingComplete: true,
    documentVaultKey: 'a'.repeat(64),
    notesCiphertext: 'encrypted-notes',
  };

  function makeController() {
    const service = {
      list: jest.fn(() => Promise.resolve([row])),
      findBySlug: jest.fn(() => Promise.resolve(row)),
      findById: jest.fn(() => Promise.resolve(row)),
    };
    return new AssociationsController(
      service as unknown as AssociationsService,
      {} as ProductsService,
      {} as FollowsService,
      {} as UserTagService,
      {} as UserProfileService
    );
  }

  it.each([
    ['list', async (c: AssociationsController) => (await c.list())[0]],
    ['findBySlug', (c: AssociationsController) => c.findBySlug('bde')],
    ['findOne', (c: AssociationsController) => c.findOne('asso1')],
  ])('never lets %s answer with the vault key or the private notes', async (_name, read) => {
    const result = await read(makeController());

    expect(result.documentVaultKey).toBeNull();
    expect(result.notesCiphertext).toBeNull();
    // The rest of the row still has to reach the app - the fix is a strip, not an allowlist.
    expect(result).toMatchObject({ id: 'asso1', name: 'BDE', stripeOnboardingComplete: true });
  });
});
