import {
  buildUserGroupSyncIndex,
  isGroupEligibleForMlsRecovery,
  findActiveDirectGroupForPeer,
} from './groupSyncEligibility';

describe('groupSyncEligibility', () => {
  it('rejects deleted groups', () => {
    const index = buildUserGroupSyncIndex([
      { groupId: 'dead', name: 'Dead', isGroup: true, deletedAt: '2026-01-01T00:00:00Z' },
      { groupId: 'live', name: 'Live', isGroup: true },
    ]);
    expect(isGroupEligibleForMlsRecovery('dead', index)).toBe(false);
    expect(isGroupEligibleForMlsRecovery('live', index)).toBe(true);
  });

  it('rejects unknown group ids when index is present', () => {
    const index = buildUserGroupSyncIndex([{ groupId: 'live', name: 'Live', isGroup: true }]);
    expect(isGroupEligibleForMlsRecovery('ghost', index)).toBe(false);
  });

  it('allows all groups when index is null', () => {
    expect(isGroupEligibleForMlsRecovery('any', null)).toBe(true);
  });

  it('finds the live direct group for a peer, ignoring deleted tombstones', () => {
    expect(
      findActiveDirectGroupForPeer(
        [
          { groupId: 'dead', name: 'alice::bob', isGroup: false, deletedAt: '2026-01-01' },
          { groupId: 'live', name: 'bob::alice', isGroup: false },
        ],
        'alice',
        'bob'
      )
    ).toBe('live');
  });

  it('returns null when only a deleted tombstone matches the peer', () => {
    expect(
      findActiveDirectGroupForPeer(
        [{ groupId: 'old', name: 'alice::bob', isGroup: false, deletedAt: '2026-01-01' }],
        'alice',
        'bob'
      )
    ).toBeNull();
  });
});
