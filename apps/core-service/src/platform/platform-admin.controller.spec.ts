import 'reflect-metadata';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { PlatformAdminController } from './platform-admin.controller';
import type { PlatformService } from './platform.service';
import type { AnnouncementService } from './announcement.service';

/**
 * The release action puts products on sale platform-wide, so the guard is asserted from the
 * metadata Nest itself reads rather than assumed from a decorator visible in a diff.
 */
describe('PlatformAdminController - release withheld products', () => {
  const GUARD_METADATA = '__guards__';

  function guardsOn(handler: keyof PlatformAdminController): unknown[] {
    const fn = (PlatformAdminController.prototype as unknown as Record<string, unknown>)[handler];
    return (Reflect.getMetadata(GUARD_METADATA, fn as object) as unknown[]) ?? [];
  }

  it('is for a global admin, behind NginxAuthGuard - like the settings PATCH beside it', () => {
    expect(guardsOn('releaseWithheldProducts')).toEqual([NginxAuthGuard, GlobalAdminGuard]);
    expect(guardsOn('updateConfig')).toEqual([NginxAuthGuard, GlobalAdminGuard]);
  });

  it('hands the normalised actor to the service and answers its counts', async () => {
    const platform = {
      releaseWithheldProducts: jest.fn().mockResolvedValue({ released: 2, failed: 0 }),
    };
    const controller = new PlatformAdminController(
      platform as unknown as PlatformService,
      {} as AnnouncementService
    );
    await expect(controller.releaseWithheldProducts('  ADMIN-1  ')).resolves.toEqual({
      released: 2,
      failed: 0,
    });
    expect(platform.releaseWithheldProducts).toHaveBeenCalledWith('admin-1');
  });
});
