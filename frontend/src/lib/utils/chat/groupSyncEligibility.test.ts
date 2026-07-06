import { describe, it, expect, vi } from 'vitest';
import {
  buildUserGroupSyncIndex,
  isGroupEligibleForMlsRecovery,
  resolveActiveGroupTarget,
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

  it('resolves successor from a deleted tombstone', () => {
    const index = buildUserGroupSyncIndex([
      {
        groupId: 'old',
        name: 'Old',
        isGroup: true,
        deletedAt: '2026-01-01',
        successorId: 'new',
      },
      { groupId: 'new', name: 'New', isGroup: true },
    ]);
    expect(resolveActiveGroupTarget('old', index)).toBe('new');
    expect(isGroupEligibleForMlsRecovery('old', index, vi.fn())).toBe(false);
  });

  it('resolves successor id even when successor is not yet in getUserGroups', () => {
    const index = buildUserGroupSyncIndex([
      {
        groupId: 'old',
        name: 'alice::bob',
        isGroup: false,
        deletedAt: '2026-01-01',
        successorId: 'new',
      },
    ]);
    expect(resolveActiveGroupTarget('old', index)).toBe('new');
    expect(
      findActiveDirectGroupForPeer(
        [
          {
            groupId: 'old',
            name: 'alice::bob',
            isGroup: false,
            deletedAt: '2026-01-01',
            successorId: 'new',
          },
        ],
        'alice',
        'bob'
      )
    ).toEqual({ groupId: 'new', tombstoneGroupId: 'old' });
  });
});
