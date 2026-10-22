import { describe, it, expect } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { describeCommunityRefusal } from './communityErrors';

describe('describeCommunityRefusal', () => {
  it('names each permission-bound refusal social-service types', () => {
    expect(describeCommunityRefusal('REMOVAL_EXCEEDS_ACTOR')).toBe(
      m.chat_community_removal_exceeds_actor_error()
    );
    expect(describeCommunityRefusal('ROLE_CHANGE_EXCEEDS_ACTOR')).toBe(
      m.chat_community_role_change_exceeds_actor_error()
    );
    expect(describeCommunityRefusal('INVITE_ROLE_NOT_GRANTABLE')).toBe(
      m.chat_invite_role_not_grantable_error()
    );
  });

  it('answers null for a code it does not know, rather than inventing a reason', () => {
    expect(describeCommunityRefusal('SOMETHING_ELSE')).toBeNull();
    expect(describeCommunityRefusal(null)).toBeNull();
  });
});
