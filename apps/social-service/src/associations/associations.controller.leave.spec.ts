import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { AssociationsController } from './associations.controller';
import { AssociationsService } from './associations.service';
import { PERM_FLAG_KEY } from './guards/global-admin-or-association-role.guard';
import { ProductsService } from './products.service';

/**
 * THE "QUITTER" BUTTON'S ROUTE (owner, 2026-11-03): any member, no role guard, and only ever the
 * caller's own row. The last-member-manager refusal is proven in `member-flag-ceiling.spec.ts`.
 */
describe('AssociationsController.leaveAssociation - the self-leave route', () => {
  const leave = AssociationsController.prototype['leaveAssociation'];

  it('is DELETE :id/members/me behind the sign-in guard alone, asking no permission flag', () => {
    expect(Reflect.getMetadata(PATH_METADATA, leave)).toBe(':id/members/me');
    expect(Reflect.getMetadata(METHOD_METADATA, leave)).toBe(RequestMethod.DELETE);
    expect(Reflect.getMetadata(GUARDS_METADATA, leave)).toEqual([NginxAuthGuard]);
    expect(Reflect.getMetadata(PERM_FLAG_KEY, leave)).toBeUndefined();
  });

  it('is declared before :id/members/:userId, so `me` is never read as a user id', () => {
    const names = Object.getOwnPropertyNames(AssociationsController.prototype);
    expect(names.indexOf('leaveAssociation')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('leaveAssociation')).toBeLessThan(names.indexOf('removeMember'));
  });

  it("removes the CALLER's row and takes no target from the request", async () => {
    const service = { leaveAssociation: jest.fn(() => Promise.resolve({ ok: true })) };
    const controller = new AssociationsController(
      service as unknown as AssociationsService,
      {} as ProductsService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    // Two parameters, the path's association and the vouched identity: there is no third one
    // through which a member could name somebody else.
    expect(leave.length).toBe(2);
    await controller.leaveAssociation('asso-a', ' user-1 ');
    expect(service.leaveAssociation).toHaveBeenCalledWith('asso-a', 'user-1');
  });
});
