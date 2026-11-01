import { describe, it, expect } from 'vitest';
import { departureToDecide, isOwnLeave, removalOutcome, SalonGrantLedger } from './memberRemoval';

describe('isOwnLeave', () => {
  it('is a leave when the local user performed their own removal, whatever the case', () => {
    expect(isOwnLeave({ channelId: 'c', kickedUserId: 'bob', kickedBy: 'Bob' }, 'bob')).toBe(true);
    expect(isOwnLeave({ channelId: 'c', kickedUserId: 'bob', kickedBy: 'carol' }, 'bob')).toBe(
      false
    );
    expect(isOwnLeave({ channelId: 'c', kickedUserId: 'bob' }, null)).toBe(false);
  });
});

describe('departureToDecide', () => {
  it('hands on the actor and its committing device, and nothing without a community', () => {
    expect(
      departureToDecide({
        channelId: 'c1',
        workspaceId: 'ws',
        kickedUserId: 'bob',
        kickedBy: 'carol',
        actorDeviceId: 'w1',
        channelIsPrivate: true,
      })
    ).toEqual({
      workspaceId: 'ws',
      channelId: 'c1',
      channelIsPrivate: true,
      departedUserId: 'bob',
      actorUserId: 'carol',
      actorDeviceId: 'w1',
    });
    expect(departureToDecide({ channelId: 'c1', kickedUserId: 'bob' })).toBeNull();
  });
});

describe('SalonGrantLedger', () => {
  it('keeps the highest grant per salon and person, ignoring the channel_ prefix', () => {
    const ledger = new SalonGrantLedger();
    ledger.noteGrant('channel_s1', ['Bob'], 5);
    ledger.noteGrant('s1', ['bob'], 3);
    expect(ledger.supersedes('s1', 'bob', 4)).toBe(true);
    expect(ledger.supersedes('s1', 'bob', 5)).toBe(false);
    expect(ledger.supersedes('s1', 'carol', 1)).toBe(false);
    ledger.clear();
    expect(ledger.supersedes('s1', 'bob', 4)).toBe(false);
  });
});

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
