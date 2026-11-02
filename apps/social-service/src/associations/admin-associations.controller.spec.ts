import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { UserResourceThrottlerGuard } from '../common/guards/user-resource-throttler.guard';
import { AdminAssociationsController } from './admin-associations.controller';

/**
 * The platform admin's entity routes are PLATFORM-ADMIN ONLY (owner, 2026-11-02): a BDE holding
 * `MANAGE_ASSO` creates through `POST /associations`, in its own campus, and is refused here - the
 * guard reads `X-Global-Admin` alone, so no BDE flag can open it.
 */
describe('AdminAssociationsController', () => {
  function contextWith(headers: Record<string, string>): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    } as unknown as ExecutionContext;
  }

  it('guards every route with the auth, the platform-admin and the per-user throttle guards', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminAssociationsController) as unknown[];
    expect(guards).toEqual([NginxAuthGuard, GlobalAdminGuard, UserResourceThrottlerGuard]);
  });

  it('refuses a caller who is not a platform admin - a BDE MANAGE_ASSO holder is one', () => {
    const guard = new GlobalAdminGuard();
    expect(() => guard.canActivate(contextWith({ 'x-user-id': 'bde-star' }))).toThrow(
      ForbiddenException
    );
    expect(guard.canActivate(contextWith({ 'x-global-admin': 'true' }))).toBe(true);
  });

  it('creates through the ONE creation function, as a platform admin, with the placement', async () => {
    const service = {
      create: jest.fn(() => Promise.resolve({ id: 'new', slug: 'club', name: 'Club' })),
    };
    const controller = new AdminAssociationsController(service as never);
    const firstAdmin = { userId: 'u1', role: 'Admin', permissions: 7 };

    await controller.create('admin-1', {
      name: 'Club',
      type: 'list',
      audiences: [{ formation: null, campus: 'gardanne' }],
      firstAdmin,
    });

    expect(service.create).toHaveBeenCalledWith({ name: 'Club', type: 'list' }, 'admin-1', true, {
      audiences: [{ formation: null, campus: 'gardanne' }],
      firstAdmin,
    });
  });
});
