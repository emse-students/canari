import { describe, it, expect } from 'vitest';
import { removalOutcome } from './memberRemoval';

describe('removalOutcome', () => {
  const me = 'u-alice';

  it('ignores a removal aimed at somebody else', () => {
    // The broadcast reaches every remaining member; acting on it wiped their sidebar too.
    expect(removalOutcome({ localUserId: me, kickedUserId: 'u-bob', channelId: 'c1' })).toBe(
      'ignore'
    );
  });

  it('ignores an event with no target', () => {
    expect(removalOutcome({ localUserId: me, kickedUserId: '', channelId: 'c1' })).toBe('ignore');
  });

  it('ignores everything while the session has no user', () => {
    expect(removalOutcome({ localUserId: null, kickedUserId: me, channelId: '' })).toBe('ignore');
  });

  it('matches the local user case-insensitively', () => {
    expect(
      removalOutcome({ localUserId: 'U-Alice', kickedUserId: 'u-alice ', channelId: '' })
    ).toBe('community');
  });

  it('reads an empty channel as a community-wide removal', () => {
    expect(removalOutcome({ localUserId: me, kickedUserId: me, channelId: '' })).toBe('community');
  });

  it('purges a private channel the user just lost', () => {
    expect(
      removalOutcome({ localUserId: me, kickedUserId: me, channelId: 'c1', channelIsPrivate: true })
    ).toBe('channel');
  });

  it('keeps a public channel, which every workspace member can still read', () => {
    expect(
      removalOutcome({
        localUserId: me,
        kickedUserId: me,
        channelId: 'c1',
        channelIsPrivate: false,
      })
    ).toBe('public-channel');
  });
});
