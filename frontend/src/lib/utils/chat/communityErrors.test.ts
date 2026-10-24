import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { describeCommunityRefusal } from './communityErrors';

describe('describeCommunityRefusal', () => {
  it('names a departure that could not be completed, as a retry', () => {
    expect(describeCommunityRefusal('DEPARTURE_SUPERSEDED')).toBe(
      m.chat_community_departure_retry_error()
    );
  });

  it('keeps the caller generic line for a code it does not know, or none', () => {
    expect(describeCommunityRefusal('SOMETHING_ELSE')).toBeNull();
    expect(describeCommunityRefusal(undefined)).toBeNull();
  });
});
