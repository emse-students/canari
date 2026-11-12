/// <reference types="jest" />

import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { UserResourceThrottlerGuard } from '../common/guards/user-resource-throttler.guard';
import {
  ChannelsController,
  COMMUNITY_CREATIONS_PER_HOUR,
  REMOVAL_RELEASES_PER_MINUTE,
} from './channels.controller';

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

/** A creation writes in two services, so one user's creations are counted per hour. */
describe('community creation rate limit', () => {
  it('runs the per-user throttler after the auth guard, ten an hour', () => {
    const handler = Object.getOwnPropertyDescriptor(ChannelsController.prototype, 'createWorkspace')
      ?.value as object;
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
      NginxAuthGuard,
      UserResourceThrottlerGuard,
    ]);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(
      COMMUNITY_CREATIONS_PER_HOUR
    );
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60 * 60_000);
  });
});
