import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import {
  FOLLOW_BLOCKED,
  FOLLOW_DAILY_LIMIT,
  FOLLOW_PENDING_LIMIT,
  FOLLOW_TARGET_NOT_FOUND,
} from './api';
import {
  describeFollowRefusal,
  followActionOf,
  followLabel,
  optimisticStatusAfter,
} from './followButton';

/** The three states of the profile's follow button (WP-F4) and what a tap does in each. */
describe('the follow button', () => {
  it.each([
    [null, 'ask', 'pending'],
    ['pending', 'withdraw', null],
    ['accepted', 'unfollow', null],
  ] as const)('from %s a tap does %s and shows %s at once', (status, action, shown) => {
    expect(followActionOf(status)).toBe(action);
    expect(optimisticStatusAfter(action)).toBe(shown);
  });

  it('labels the three states Suivre, Demande envoyee, Abonne', () => {
    expect(followLabel(null)).toBe(m.profile_public_follow_btn());
    expect(followLabel('pending')).toBe(m.profile_follow_requested_btn());
    expect(followLabel('accepted')).toBe(m.profile_public_following_btn());
    expect(new Set([followLabel(null), followLabel('pending'), followLabel('accepted')]).size).toBe(
      3
    );
  });

  it('words a refusal from its code, and anything else generically', () => {
    expect(describeFollowRefusal(FOLLOW_BLOCKED)).toBe(m.refusal_follow_blocked());
    expect(describeFollowRefusal(FOLLOW_TARGET_NOT_FOUND)).toBe(
      m.refusal_follow_target_not_found()
    );
    expect(describeFollowRefusal(FOLLOW_PENDING_LIMIT)).toBe(m.refusal_follow_pending_limit());
    expect(describeFollowRefusal(FOLLOW_DAILY_LIMIT)).toBe(m.refusal_follow_daily_limit());
    expect(describeFollowRefusal(null)).toBe(m.profile_follow_error());
    expect(describeFollowRefusal('SOMETHING_ELSE')).toBe(m.profile_follow_error());
  });
});
