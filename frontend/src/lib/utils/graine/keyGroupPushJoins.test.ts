import { describe, it, expect, vi } from 'vitest';

vi.mock('./runtime', () => ({
  workspaceForChannel: (channelId: string) => (channelId === 'known-salon' ? 'ws-of-salon' : null),
}));

import { adoptKeyGroupPushJoins, type KeyGroupPushJoin } from './keyGroupPushJoins';

/**
 * What the app does with the key groups a shut phone joined from a push (channel-encryption
 * section 26). The ledger is a CLAIM and the loaded MLS state is the FACT: only a group both say
 * was joined reaches the registry, and every other entry is left to the community load, which
 * joins it the ordinary way.
 */
describe('adoptKeyGroupPushJoins', () => {
  const run = (entries: KeyGroupPushJoin[], held: string[], known: string[] = []) => {
    const registered: Array<{ scope: unknown; groupId: string }> = [];
    const noted: string[] = [];
    const lines: string[] = [];
    const result = adoptKeyGroupPushJoins(
      {
        registerDistributionGroup: (scope, groupId) => registered.push({ scope, groupId }),
        noteDistributionGroup: (groupId) => noted.push(groupId),
        isDistributionGroup: (groupId) => known.includes(groupId),
      },
      entries,
      (line) => lines.push(line),
      (groupId) => held.includes(groupId)
    );
    return { result, registered, noted, lines };
  };

  it('registers a joined community key group with its workspace scope', () => {
    const r = run(
      [{ groupId: 'g-ws', state: 'joined', scopeKind: 'workspace', scopeId: 'ws1' }],
      ['g-ws']
    );
    expect(r.registered).toEqual([
      { scope: { kind: 'workspace', workspaceId: 'ws1' }, groupId: 'g-ws' },
    ]);
    expect(r.result).toEqual({ registered: 1, noted: 0, ignored: 0 });
  });

  it('registers a salon key group when its community is known, and notes it otherwise', () => {
    const r = run(
      [
        { groupId: 'g-known', state: 'joined', scopeKind: 'channel', scopeId: 'known-salon' },
        { groupId: 'g-unknown', state: 'joined', scopeKind: 'channel', scopeId: 'other-salon' },
      ],
      ['g-known', 'g-unknown']
    );
    expect(r.registered).toEqual([
      {
        scope: { kind: 'channel', workspaceId: 'ws-of-salon', channelId: 'known-salon' },
        groupId: 'g-known',
      },
    ]);
    expect(r.noted).toEqual(['g-unknown']);
  });

  it('believes the tree over the ledger: a joined group missing from the state is ignored', () => {
    const r = run(
      [{ groupId: 'g-gone', state: 'joined', scopeKind: 'workspace', scopeId: 'ws1' }],
      []
    );
    expect(r.registered).toEqual([]);
    expect(r.noted).toEqual([]);
    expect(r.result.ignored).toBe(1);
    expect(r.lines.join('\n')).toContain('NOT in the loaded state');
  });

  it('never overwrites a mapping the registry already holds', () => {
    const r = run(
      [{ groupId: 'g-known', state: 'joined', scopeKind: 'workspace', scopeId: 'ws-from-push' }],
      ['g-known'],
      ['g-known']
    );
    expect(r.registered).toEqual([]);
    expect(r.noted).toEqual([]);
    expect(r.lines.some((line) => line.includes('existing mapping kept'))).toBe(true);
  });

  it('registers nothing for refused, lost or interrupted attempts, and says each', () => {
    const r = run(
      [
        { groupId: 'g-ref', state: 'refused', reason: 'base-forbidden' },
        { groupId: 'g-lost', state: 'lost', reason: 'install-refused' },
        { groupId: 'g-att', state: 'attempting' },
        { groupId: 'g-def', state: 'deferred', reason: 'prepare-epoch-mismatch' },
      ],
      ['g-ref', 'g-lost', 'g-att', 'g-def']
    );
    expect(r.registered).toEqual([]);
    expect(r.noted).toEqual([]);
    expect(r.result.ignored).toBe(4);
    expect(r.lines).toHaveLength(4);
  });
});
