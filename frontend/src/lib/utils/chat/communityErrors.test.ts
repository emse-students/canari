import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { describeCommunityRefusal } from './communityErrors';

describe('describeCommunityRefusal', () => {
  it('names a departure that could not be completed, as a retry', () => {
    expect(describeCommunityRefusal('DEPARTURE_SUPERSEDED')).toBe(
      m.chat_community_departure_retry_error()
    );
  });

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

  it('names a salon access edit raced by another one, as a retry', () => {
    expect(describeCommunityRefusal('CHANNEL_ACCESS_CHANGED')).toBe(
      m.chat_channel_access_changed_error()
    );
  });

  it('names a salon grant of someone no longer in the community, apart from a race', () => {
    expect(describeCommunityRefusal('CHANNEL_GRANTEE_NOT_MEMBER')).toBe(
      m.chat_channel_grantee_not_member_error()
    );
    expect(m.chat_channel_grantee_not_member_error()).not.toBe(
      m.chat_channel_access_changed_error()
    );
  });

  it('names a role change raced by another edit of the member, as a retry', () => {
    expect(describeCommunityRefusal('MEMBER_CHANGED_MEANWHILE')).toBe(
      m.chat_community_member_changed_error()
    );
  });

  it('keeps the caller generic line for a code it does not know, or none', () => {
    expect(describeCommunityRefusal('SOMETHING_ELSE')).toBeNull();
    expect(describeCommunityRefusal(undefined)).toBeNull();
    expect(describeCommunityRefusal(null)).toBeNull();
  });
});
