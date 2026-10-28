/// <reference types="jest" />

import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { UserResourceThrottlerGuard } from '../common/guards/user-resource-throttler.guard';
import { ChannelsController, REMOVAL_RELEASES_PER_MINUTE } from './channels.controller';

/**
 * A release fans an event out to every member of the scope, so a loop - a stuck tab, a script -
 * must not drive it: both release routes are throttled per user, after the guard that proves the id.
 */
describe('removal-released routes rate limit', () => {
  it.each(['releaseWorkspaceRemoval', 'releaseChannelRemoval'])(
    '%s runs the per-user throttler after the auth guard, at its own limit',
    (name) => {
      const handler = Object.getOwnPropertyDescriptor(ChannelsController.prototype, name)
        ?.value as object;
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
        NginxAuthGuard,
        UserResourceThrottlerGuard,
      ]);
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(
        REMOVAL_RELEASES_PER_MINUTE
      );
    }
  );
});
