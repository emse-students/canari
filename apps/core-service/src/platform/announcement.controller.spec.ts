/// <reference types="jest" />

import { PATH_METADATA } from '@nestjs/common/constants';
import { AnnouncementController } from './announcement.controller';
import { UsersController } from '../users/users.controller';

/**
 * WHERE THE ROUTE LIVES, WHICH IS THE ONLY REASON THE FEATURE EVER FAILED.
 *
 * `@Controller('users/announcement')` mapped a route Express never reached: `UsersModule` is
 * imported first in `AppModule`, so `{/api/users/:id, GET}` was registered ahead of it and matched
 * `/api/users/announcement` with `id = "announcement"`. The users service answered 404 for an
 * account that does not exist, the client logged it at `debug`, and the announcement had never once
 * been shown since it shipped. Measured on production 2026-08-19 from the service's own
 * `RouterExplorer` lines.
 *
 * The fix is a property of the PATH rather than of the import list, so this is what has to hold: a
 * two-segment `users/<word>` route is reachable only if it happens to be registered before the
 * catch-all, and nothing here can promise that. A third segment cannot collide at all.
 */
describe('the announcement route cannot be captured by the users catch-all', () => {
  const path = (c: object) => String(Reflect.getMetadata(PATH_METADATA, c));

  it('does not sit at users/<word>, where the :id route would capture it', () => {
    const segments = path(AnnouncementController).split('/').filter(Boolean);

    expect(segments[0]).toBe('users');
    // Two segments IS the collision. Any third segment removes it, whatever the module order.
    expect(segments.length).toBeGreaterThan(2);
  });

  it('names the catch-all it must not collide with, so this test dies if that route moves', () => {
    // If `UsersController` ever stops being mounted at `users`, the collision this guards against
    // no longer exists and the reasoning above has to be re-read rather than silently kept.
    expect(path(UsersController)).toBe('users');
  });
});
