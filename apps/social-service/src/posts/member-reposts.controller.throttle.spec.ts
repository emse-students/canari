/// <reference types="jest" />

import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UserResourceThrottlerGuard } from '../common/guards/user-resource-throttler.guard';
import {
  MEMBER_REPOST_WRITES_PER_MINUTE,
  MemberRepostsController,
  REPOST_CONSENT_WRITES_PER_MINUTE,
  REPOST_SETTINGS_READS_PER_MINUTE,
} from './member-reposts.controller';

/**
 * Every member-repost route is throttled PER CALLER (WP-F6): a repost fans a notification out and
 * drops its audience's feeds, a consent change deletes reposts - a loop (a stuck tab, a script) must
 * not drive either. The routes name `:postId`, which the guard does not read, so the bucket is the
 * caller alone, across every post.
 */
describe('member repost routes rate limit', () => {
  const proto = MemberRepostsController.prototype as unknown as Record<string, object>;

  it.each([
    ['repost', MEMBER_REPOST_WRITES_PER_MINUTE],
    ['unrepost', MEMBER_REPOST_WRITES_PER_MINUTE],
    ['setMyRepostSettings', REPOST_CONSENT_WRITES_PER_MINUTE],
    ['setPostConsent', REPOST_CONSENT_WRITES_PER_MINUTE],
    ['myRepostSettings', REPOST_SETTINGS_READS_PER_MINUTE],
  ])('%s runs the per-user throttler at its own limit', (name, limit) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, proto[name])).toEqual([UserResourceThrottlerGuard]);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto[name])).toBe(limit);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', proto[name])).toBe(60_000);
  });

  it('keys a repost on the caller alone, whatever the post', async () => {
    const guard = Object.create(UserResourceThrottlerGuard.prototype) as {
      getTracker(req: Record<string, unknown>): Promise<string>;
    };
    const req = (postId: string) => ({
      ip: '172.25.0.1',
      method: 'POST',
      url: `/api/posts/${postId}/reposts`,
      headers: { 'x-user-id': 'user-a' },
      params: { postId },
    });
    expect(await guard.getTracker(req('p1'))).toBe(await guard.getTracker(req('p2')));
  });

  it('keeps the limits where a person stays below and a loop does not', () => {
    for (const limit of [MEMBER_REPOST_WRITES_PER_MINUTE, REPOST_CONSENT_WRITES_PER_MINUTE]) {
      expect(limit).toBeGreaterThanOrEqual(5);
      expect(limit).toBeLessThanOrEqual(30);
    }
  });
});
