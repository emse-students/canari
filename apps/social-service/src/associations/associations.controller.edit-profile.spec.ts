import type { SpacesService } from '../spaces/spaces.service';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { AssociationsController } from './associations.controller';
import { AssociationsService } from './associations.service';
import { AssociationPermissionFlag } from './entities/association-member.entity';
import {
  GlobalAdminOrAssociationRoleGuard,
  PERM_FLAG_KEY,
} from './guards/global-admin-or-association-role.guard';
import {
  ASSOCIATION_FIELD_PLATFORM_ADMIN_ONLY,
  ASSOCIATION_FIELD_RIGHT_MISSING,
  PLATFORM_ADMIN_ONLY,
  UPDATE_FIELD_RIGHTS,
} from './association-update-rights';
import { FollowsService } from '../follows/follows.service';
import { PartnershipsService } from './partnerships.service';
import { ProductsService } from './products.service';
import { UserProfileService } from './user-profile.service';
import { UserTagService } from '../users/user-tag.service';

/**
 * EDITING THE PROFILE IS ITS OWN RIGHT, AND `PATCH :id` ASKS EACH FIELD'S (owner, 2026-11-02).
 *
 * `EDIT_PROFILE` is split from `MANAGE_MEMBERS`, which used to gate `PATCH :id` and the logo routes.
 * Each case runs the REAL guard and the REAL controller over a service whose `mayAct` reads one
 * member's bitmask, so the right a field asks is the right that admits it, and nothing else does.
 */
describe('AssociationsController - every PATCH field asks its own right', () => {
  const ASSO = '00000000-0000-4000-8000-0000000000aa';
  const F = AssociationPermissionFlag;
  const proto = AssociationsController.prototype as unknown as Record<string, object>;
  const LOGO_ROUTES = ['uploadLogo', 'deleteLogo'] as const;
  const STORED_PARENT = '00000000-0000-4000-8000-0000000000cc';

  /** The real guard and controller over a service granting exactly `bitmask` to `member`. */
  function harness(bitmask: number) {
    const service = {
      mayAct: jest.fn((userId: string, associationId: string, flag: number) =>
        Promise.resolve(userId === 'member' && associationId === ASSO && (bitmask & flag) !== 0)
      ),
      isMember: jest.fn(() => Promise.resolve(true)),
      isAssociationSuperAdminOf: jest.fn(() => Promise.resolve(false)),
      // The stored row: a list under STORED_PARENT, with the default quota.
      findById: jest.fn(() =>
        Promise.resolve({
          id: ASSO,
          type: 'list',
          parentAssociationId: STORED_PARENT,
          documentQuotaBytes: '524288000',
        })
      ),
      update: jest.fn((_id: string, patch: unknown) =>
        Promise.resolve({ id: ASSO, type: 'association', ...(patch as object) })
      ),
    };
    const productsService = { provisionCotisationProduct: jest.fn(() => Promise.resolve()) };
    // The governing parent is a dependency (WP-D1): a platform admin's change goes through it.
    const spaces = { setParent: jest.fn(() => Promise.resolve()) };
    const guard = new GlobalAdminOrAssociationRoleGuard(
      new Reflector(),
      service as unknown as AssociationsService
    );
    const context = (route: string) =>
      ({
        getHandler: () => proto[route],
        switchToHttp: () => ({
          getRequest: () => ({ headers: { 'x-user-id': 'member' }, params: { id: ASSO } }),
        }),
      }) as unknown as ExecutionContext;
    const controller = new AssociationsController(
      service as unknown as AssociationsService,
      productsService as unknown as ProductsService,
      {} as PartnershipsService,
      {} as FollowsService,
      {} as UserTagService,
      {} as UserProfileService,
      {} as never,
      spaces as unknown as SpacesService
    );
    return { guard, context, controller, service, spaces };
  }

  /** The typed body of a refusal, so a test asserts the code, never the prose. */
  async function refusal(promise: Promise<unknown>): Promise<Record<string, unknown>> {
    const error = await promise.then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(ForbiddenException);
    return (error as ForbiddenException).getResponse() as Record<string, unknown>;
  }

  it('places every field: the profile, the archive, the cotisation, the platform-admin pair', () => {
    expect(UPDATE_FIELD_RIGHTS).toMatchObject({
      name: F.EDIT_PROFILE,
      logoUrl: F.EDIT_PROFILE,
      promo: F.EDIT_PROFILE,
      logoMediaId2: F.EDIT_PROFILE,
      archived: F.MANAGE_MEMBERS,
      cotisationEnabled: F.MANAGE_PRODUCTS,
      documentQuotaBytes: PLATFORM_ADMIN_ONLY,
      parentAssociationId: PLATFORM_ADMIN_ONLY,
    });
  });

  it('PATCH :id asks membership at the guard and decides per field', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, proto.update) as unknown[];
    expect(guards).toContain(NginxAuthGuard);
    expect(guards).toContain(GlobalAdminOrAssociationRoleGuard);
    expect(Reflect.getMetadata(PERM_FLAG_KEY, proto.update)).toBeUndefined();
  });

  it.each(LOGO_ROUTES)('%s asks EDIT_PROFILE behind the sign-in guard', (route) => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, proto[route]) as unknown[];
    expect(guards).toContain(NginxAuthGuard);
    expect(guards).toContain(GlobalAdminOrAssociationRoleGuard);
    expect(Reflect.getMetadata(PERM_FLAG_KEY, proto[route])).toBe(F.EDIT_PROFILE);
  });

  it('lets a holder of EDIT_PROFILE without MANAGE_MEMBERS edit the profile and the logos', async () => {
    const { guard, context, controller, service } = harness(F.EDIT_PROFILE);
    for (const route of LOGO_ROUTES) {
      await expect(guard.canActivate(context(route))).resolves.toBe(true);
    }
    const body = { name: 'Nouveau nom', description: 'Texte', contactEmail: 'bureau@example.org' };
    await controller.update(ASSO, 'member', undefined, body);
    expect(service.update).toHaveBeenCalledWith(ASSO, body);
  });

  it('refuses that holder the archive, which is MANAGE_MEMBERS, and writes nothing', async () => {
    const { controller, service } = harness(F.EDIT_PROFILE);
    const body = await refusal(
      controller.update(ASSO, 'member', undefined, { name: 'x', archived: true })
    );
    expect(body).toMatchObject({
      code: ASSOCIATION_FIELD_RIGHT_MISSING,
      right: 'MANAGE_MEMBERS',
      fields: ['archived'],
    });
    expect(service.update).not.toHaveBeenCalled();
  });

  it('refuses a holder of MANAGE_MEMBERS without EDIT_PROFILE the profile and the logos', async () => {
    const { guard, context, controller, service } = harness(F.MANAGE_MEMBERS);
    for (const route of LOGO_ROUTES) {
      await expect(guard.canActivate(context(route))).rejects.toBeInstanceOf(ForbiddenException);
    }
    const body = await refusal(controller.update(ASSO, 'member', undefined, { name: 'x' }));
    expect(body).toMatchObject({ code: ASSOCIATION_FIELD_RIGHT_MISSING, right: 'EDIT_PROFILE' });
    expect(service.update).not.toHaveBeenCalled();
  });

  it('lets that holder archive, the archive asking MANAGE_MEMBERS alone', async () => {
    const { controller, service } = harness(F.MANAGE_MEMBERS);
    await controller.update(ASSO, 'member', undefined, { archived: true });
    expect(service.update).toHaveBeenCalledWith(ASSO, { archived: true });
  });

  it('lets a holder of MANAGE_PRODUCTS alone save the cotisation settings it is offered', async () => {
    const { controller, service } = harness(F.MANAGE_PRODUCTS);
    await controller.update(ASSO, 'member', undefined, {
      cotisationEnabled: true,
      cotisationMode: 'lifetime',
    });
    expect(service.update).toHaveBeenCalled();
  });

  /** Every flag a member could hold, so a refusal is about the field and never a missing flag. */
  const ALL = Object.values(F)
    .filter((v): v is number => typeof v === 'number')
    .reduce((a, b) => a | b, 0);

  it('refuses documentQuotaBytes to every member, with a typed code, and lets the platform admin write it', async () => {
    const dto = { documentQuotaBytes: 1 };
    const { controller, service } = harness(ALL);
    const body = await refusal(controller.update(ASSO, 'member', undefined, dto));
    expect(body).toMatchObject({
      code: ASSOCIATION_FIELD_PLATFORM_ADMIN_ONLY,
      fields: ['documentQuotaBytes'],
    });
    expect(service.update).not.toHaveBeenCalled();

    await controller.update(ASSO, 'admin', 'true', dto);
    expect(service.update).toHaveBeenCalledWith(ASSO, dto);
  });

  it('refuses parentAssociationId to every member, and sends a platform admin change to the dependency (2.7)', async () => {
    const dto = { parentAssociationId: '00000000-0000-4000-8000-0000000000bb' };
    const { controller, service, spaces } = harness(ALL);
    const body = await refusal(controller.update(ASSO, 'member', undefined, dto));
    expect(body).toMatchObject({
      code: ASSOCIATION_FIELD_PLATFORM_ADMIN_ONLY,
      fields: ['parentAssociationId'],
    });
    expect(spaces.setParent).not.toHaveBeenCalled();

    // Judged and journaled as a dependency, never written by the profile update.
    await controller.update(ASSO, 'admin', 'true', dto);
    expect(spaces.setParent).toHaveBeenCalledWith(ASSO, dto.parentAssociationId, {
      userId: 'admin',
    });
    expect(service.update).not.toHaveBeenCalled();
  });

  it('splits a platform admin body: the parent to the dependency, the rest to the profile', async () => {
    const { controller, service, spaces } = harness(0);
    // mayAct answers true for every flag to a platform admin.
    service.mayAct.mockResolvedValue(true);
    await controller.update(ASSO, 'admin', 'true', { name: 'Liste', parentAssociationId: null });
    expect(spaces.setParent).toHaveBeenCalledWith(ASSO, null, { userId: 'admin' });
    expect(service.update).toHaveBeenCalledWith(ASSO, { name: 'Liste' });
  });

  /**
   * LEGACY until 2027-05-03: a store build up to 1.6.2 resends `parentAssociationId: editParentId ||
   * null` on every list save. An unchanged value is dropped before the rights are asked; a changed
   * one is still refused.
   */
  it.each([
    ['the stored parent', STORED_PARENT],
    ['null, for a list that has none', null],
  ])('saves a profile resent with %s, without writing the parent', async (_label, sent) => {
    const { controller, service } = harness(F.EDIT_PROFILE);
    if (sent === null) {
      service.findById.mockResolvedValueOnce({
        id: ASSO,
        type: 'list',
        parentAssociationId: null as unknown as string,
        documentQuotaBytes: '524288000',
      });
    }
    await controller.update(ASSO, 'member', undefined, {
      name: 'Liste',
      parentAssociationId: sent,
    });
    expect(service.update).toHaveBeenCalledWith(ASSO, { name: 'Liste' });
  });

  it('still refuses a CHANGED parent from that holder', async () => {
    const { controller, service } = harness(F.EDIT_PROFILE);
    const body = await refusal(
      controller.update(ASSO, 'member', undefined, {
        name: 'Liste',
        parentAssociationId: '00000000-0000-4000-8000-0000000000dd',
      })
    );
    expect(body).toMatchObject({ code: ASSOCIATION_FIELD_PLATFORM_ADMIN_ONLY });
    expect(service.update).not.toHaveBeenCalled();
  });

  it('refuses a mixed body whose second right is missing, and saves nothing of it', async () => {
    const { controller, service } = harness(F.EDIT_PROFILE);
    const body = await refusal(
      controller.update(ASSO, 'member', undefined, { name: 'x', cotisationEnabled: true })
    );
    expect(body).toMatchObject({
      code: ASSOCIATION_FIELD_RIGHT_MISSING,
      right: 'MANAGE_PRODUCTS',
      fields: ['cotisationEnabled'],
    });
    expect(service.update).not.toHaveBeenCalled();
  });
});
