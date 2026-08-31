import {
  classifyServerStatus,
  decideAbsentGroupFate,
  decideAbsentLocalGroupFate,
  reconcileAbsentLocalGroup,
  type AbsentGroupFateInput,
  type ConversationLifecycle,
  type GroupServerStatus,
} from './groupLifecycle';
import type { GroupMeta } from '$lib/mls-client/IMlsService';
import { workspaceScope } from '$lib/mls-client/distributionScope';

describe('classifyServerStatus', () => {
  it("'absent' -> kind absent", () => {
    expect(classifyServerStatus('absent')).toEqual({ kind: 'absent' });
  });

  it("'error' -> kind unknown (network doubt)", () => {
    expect(classifyServerStatus('error')).toEqual({ kind: 'unknown' });
  });

  it('GroupMeta with no deletedAt -> active', () => {
    const meta: GroupMeta = { groupId: 'g1', name: 'Equipe', deletedAt: null };
    expect(classifyServerStatus(meta)).toEqual({ kind: 'active', meta });
  });

  it('GroupMeta with a deletedAt -> tombstone', () => {
    const meta: GroupMeta = { groupId: 'g1', deletedAt: '2026-06-20T00:00:00Z' };
    expect(classifyServerStatus(meta)).toEqual({ kind: 'tombstone', meta });
  });
});

describe('decideAbsentGroupFate', () => {
  const base: AbsentGroupFateInput = {
    lifecycle: 'active',
    serverStatus: { kind: 'absent' },
    isStillUserMember: null,
  };
  const make = (o: Partial<AbsentGroupFateInput>): AbsentGroupFateInput => ({ ...base, ...o });
  const active = (): GroupServerStatus => ({ kind: 'active', meta: { groupId: 'g1' } });
  const tombstone = (): GroupServerStatus => ({
    kind: 'tombstone',
    meta: { groupId: 'g1', deletedAt: '2026-06-20T00:00:00Z' },
  });

  // -- Priority guards, which short-circuit the server state --
  it('already removed -> keep (deleted by hand only, never re-purged)', () => {
    expect(decideAbsentGroupFate(make({ lifecycle: 'removed' })).action).toBe('keep');
  });

  it('removed wins even when the server confirms absent', () => {
    const fate = decideAbsentGroupFate(
      make({ lifecycle: 'removed', serverStatus: { kind: 'absent' } })
    );
    expect(fate.action).toBe('keep');
  });

  // -- confirmed absent --
  it('confirmed absent -> purge', () => {
    expect(decideAbsentGroupFate(make({ serverStatus: { kind: 'absent' } })).action).toBe('purge');
  });

  // -- network doubt --
  it('unknown (network) -> keep (a doubt never purges)', () => {
    expect(decideAbsentGroupFate(make({ serverStatus: { kind: 'unknown' } })).action).toBe('keep');
  });

  // -- tombstone --
  it('tombstone + active -> markRemoved (banner)', () => {
    expect(
      decideAbsentGroupFate(make({ serverStatus: tombstone(), lifecycle: 'active' })).action
    ).toBe('markRemoved');
  });

  it('tombstone + placeholder (pending) -> keep', () => {
    expect(
      decideAbsentGroupFate(make({ serverStatus: tombstone(), lifecycle: 'pending' })).action
    ).toBe('keep');
  });

  // -- active, the membership anti-race --
  it('active + members unavailable (null) -> keep (doubt)', () => {
    expect(
      decideAbsentGroupFate(make({ serverStatus: active(), isStillUserMember: null })).action
    ).toBe('keep');
  });

  it('active + still a member -> keep (stale snapshot)', () => {
    expect(
      decideAbsentGroupFate(make({ serverStatus: active(), isStillUserMember: true })).action
    ).toBe('keep');
  });

  it('active + no longer a member + lifecycle active -> markRemoved (exclusion)', () => {
    expect(
      decideAbsentGroupFate(
        make({ serverStatus: active(), isStillUserMember: false, lifecycle: 'active' })
      ).action
    ).toBe('markRemoved');
  });

  it('active + no longer a member + placeholder (pending) -> keep', () => {
    expect(
      decideAbsentGroupFate(
        make({ serverStatus: active(), isStillUserMember: false, lifecycle: 'pending' })
      ).action
    ).toBe('keep');
  });

  // ── Key invariant: never purge except on confirmed absent ──
  it('only confirmed absent produces purge (never tombstone/active/unknown)', () => {
    const nonAbsent: GroupServerStatus[] = [active(), tombstone(), { kind: 'unknown' }];
    const lifecycles: ConversationLifecycle[] = ['active', 'pending', 'removed'];
    for (const serverStatus of nonAbsent) {
      for (const lifecycle of lifecycles) {
        for (const isStillUserMember of [true, false, null]) {
          const fate = decideAbsentGroupFate(make({ serverStatus, lifecycle, isStillUserMember }));
          expect(fate.action).not.toBe('purge');
        }
      }
    }
  });
});

describe('decideAbsentLocalGroupFate', () => {
  const distribution = (): GroupServerStatus => ({
    kind: 'active',
    meta: { groupId: 'd-1', distributionWorkspaceId: 'ws-1' },
  });

  // WHAT THIS SESSION REMEMBERS IS NOT EVIDENCE THAT THE GROUP STILL EXISTS. This used to keep, on
  // the strength of the local predicate alone, and nothing could ever collect what it spared: the
  // purge that owns a community's carriers enumerates scopes, and a carrier noted without a scope is
  // in none of them. Prod 2026-08-21: one such group held for hours after its community was deleted,
  // starting a recovery attempt on every load. `absent` is a read of `dm_groups` with no membership
  // check, and a carrier is named by the server before it can be joined - so it cannot be premature.
  it('forgets a registered seed carrier whose dm_groups row is confirmed gone', () => {
    expect(
      decideAbsentLocalGroupFate({
        isKnownDistributionGroup: true,
        serverStatus: { kind: 'absent' },
      })
    ).toEqual({
      action: 'forget',
      reason: 'absent from dm_groups (confirmed)',
    });
  });

  // The measured state, exactly: deleting a community tombstones its group's row AND clears the
  // distribution columns, so the row no longer names any scope. The local predicate goes on saying
  // "seed carrier" for the rest of the session; the row is what decides.
  it('forgets a registered seed carrier whose row has stopped naming a scope', () => {
    expect(
      decideAbsentLocalGroupFate({
        isKnownDistributionGroup: true,
        serverStatus: {
          kind: 'tombstone',
          meta: { groupId: 'd-1', deletedAt: '2026-08-21T05:50:52Z' },
        },
      }).action
    ).toBe('forget');
  });

  it('keeps a distribution group the ROW names, which is how a cold boot learns it', () => {
    // WP-GRAINE-1: at boot nothing has registered anything yet, so the local predicate is false
    // and the row is the only thing that can save the group.
    expect(
      decideAbsentLocalGroupFate({
        isKnownDistributionGroup: false,
        serverStatus: distribution(),
      }).action
    ).toBe('keep');
  });

  it('keeps a tombstoned distribution group too - a community being deleted is not a purge cue', () => {
    expect(
      decideAbsentLocalGroupFate({
        isKnownDistributionGroup: false,
        serverStatus: {
          kind: 'tombstone',
          meta: { groupId: 'd-1', distributionWorkspaceId: 'ws-1', deletedAt: '2026-08-19' },
        },
      }).action
    ).toBe('keep');
  });

  it('never destroys on network doubt', () => {
    expect(
      decideAbsentLocalGroupFate({
        isKnownDistributionGroup: false,
        serverStatus: { kind: 'unknown' },
      }).action
    ).toBe('keep');
  });

  // The one case the local flag is still consulted in - and it is the only one where nothing better
  // exists. An unreadable row must never cost a live community its seed carrier (WP-GRAINE-1).
  it('spares a registered seed carrier when the row cannot be read at all', () => {
    expect(
      decideAbsentLocalGroupFate({
        isKnownDistributionGroup: true,
        serverStatus: { kind: 'unknown' },
      })
    ).toEqual({
      action: 'keep',
      reason: 'key-distribution group registered on this device, server status uncertain',
    });
  });

  it('forgets a conversation whose dm_groups row is confirmed gone', () => {
    expect(
      decideAbsentLocalGroupFate({
        isKnownDistributionGroup: false,
        serverStatus: { kind: 'absent' },
      }).action
    ).toBe('forget');
  });

  it('forgets a row that names no distribution scope - the behaviour the sweep always had', () => {
    for (const serverStatus of [
      { kind: 'active', meta: { groupId: 'g1' } } as GroupServerStatus,
      {
        kind: 'tombstone',
        meta: { groupId: 'g1', deletedAt: '2026-06-20T00:00:00Z' },
      } as GroupServerStatus,
    ]) {
      expect(
        decideAbsentLocalGroupFate({ isKnownDistributionGroup: false, serverStatus }).action
      ).toBe('forget');
    }
  });

  /**
   * A DESTRUCTIVE BRANCH MAY NOT NAME A FACT IT NEVER READ. This one said
   * `'conversation row held with no membership left'` and reduces no membership at all - its whole
   * input is a `dm_groups` row and a local predicate. The sentence is what a reader reaches for
   * after a group has been forgotten and nobody knows why, so a wrong one sends them to the wrong
   * table. Pinned as a STRING because the string is the deliverable.
   */
  it('states only the facts it actually reduced, and never a membership', () => {
    const reasons = (['active', 'tombstone'] as const).map(
      (kind) =>
        decideAbsentLocalGroupFate({
          isKnownDistributionGroup: false,
          serverStatus: { kind, meta: { groupId: 'g1', deletedAt: '2026-06-20T00:00:00Z' } },
        }).reason
    );
    expect(reasons).toEqual([
      'dm_groups row alive, naming no distribution scope, absent from our group list',
      'dm_groups row tombstoned and naming no distribution scope',
    ]);
    for (const reason of reasons) expect(reason).not.toMatch(/member/i);
  });
});

describe('reconcileAbsentLocalGroup', () => {
  const makeMls = (status: 'absent' | 'error' | GroupMeta, known = false) => ({
    isDistributionGroup: vi.fn().mockReturnValue(known),
    getGroupServerStatus: vi.fn().mockResolvedValue(status),
    registerDistributionGroup: vi.fn(),
    noteDistributionGroup: vi.fn(),
  });

  // IT ASKS EVEN WHEN IT ALREADY KNOWS WHAT THE GROUP IS, because the two questions have different
  // lifetimes: the predicate is true for the session, the group can stop existing inside it. The
  // short-circuit that used to live here is what left a deleted community's carrier held for ever.
  it('reads the row even for a group it has already registered, and believes it', async () => {
    const mls = makeMls('absent', true);
    expect((await reconcileAbsentLocalGroup(mls, 'd-1')).action).toBe('forget');
    expect(mls.getGroupServerStatus).toHaveBeenCalledWith('d-1');
  });

  it('still spares a registered group when the read fails', async () => {
    const mls = makeMls('error', true);
    expect((await reconcileAbsentLocalGroup(mls, 'd-1')).action).toBe('keep');
  });

  it('registers the community it just learnt about, so no later sweep asks again', async () => {
    const mls = makeMls({ groupId: 'd-1', distributionWorkspaceId: 'ws-1' });
    expect((await reconcileAbsentLocalGroup(mls, 'd-1')).action).toBe('keep');
    expect(mls.registerDistributionGroup).toHaveBeenCalledWith(workspaceScope('ws-1'), 'd-1');
  });

  it('registers nothing for a plain conversation, and lets it be forgotten', async () => {
    const mls = makeMls('absent');
    expect((await reconcileAbsentLocalGroup(mls, 'g-1')).action).toBe('forget');
    expect(mls.registerDistributionGroup).not.toHaveBeenCalled();
    expect(mls.noteDistributionGroup).not.toHaveBeenCalled();
  });

  // THE DISCRIMINATOR THE SERVER GAVE US MUST SURVIVE THE FACT THAT WE CANNOT NAME THE SCOPE. A
  // salon's `dm_groups` row carries the salon but not its community, so a session that has not
  // loaded that community can keep the group - and used to forget WHY, leaving
  // `isDistributionGroup` answering false about a group the server had just identified. Everything
  // downstream inherited it, the history reconciliation included, which then probed a seed carrier
  // as though it were a conversation.
  it('still records WHAT a salon group is when it cannot yet say WHOSE', async () => {
    const mls = makeMls({ groupId: 'd-2', distributionChannelId: 'ch-unknown-community' });
    expect((await reconcileAbsentLocalGroup(mls, 'd-2')).action).toBe('keep');
    expect(mls.registerDistributionGroup).not.toHaveBeenCalled();
    expect(mls.noteDistributionGroup).toHaveBeenCalledWith('d-2');
  });
});
