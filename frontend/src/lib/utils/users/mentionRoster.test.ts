import { describe, it, expect } from 'vitest';
import { buildMentionRoster, suggestFromRoster } from './mentionRoster';

describe('buildMentionRoster', () => {
  it('stamps each member with their latest non-system message, matching ids case-insensitively', () => {
    const roster = buildMentionRoster(
      ['Alice', 'bob', 'carl'],
      [
        { senderId: 'alice', timestamp: new Date(1000), isSystem: false },
        { senderId: 'ALICE', timestamp: new Date(5000), isSystem: false },
        { senderId: 'bob', timestamp: new Date(9000), isSystem: true },
      ]
    );
    expect(roster).toEqual([
      { id: 'Alice', lastSpokeAt: 5000 },
      { id: 'bob', lastSpokeAt: undefined },
      { id: 'carl', lastSpokeAt: undefined },
    ]);
  });
});

describe('suggestFromRoster', () => {
  it('leaves out a member whose name is unknown and de-duplicates ids', () => {
    const rows = suggestFromRoster(
      [{ id: 'a', displayName: 'Ana' }, { id: 'A', displayName: 'Ana' }, { id: 'b' }],
      '',
      { excludeIds: [], resolveName: () => null }
    );
    expect(rows).toEqual([{ id: 'a', displayName: 'Ana' }]);
  });
});
