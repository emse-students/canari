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

  it("'error' -> kind unknown (doute reseau)", () => {
    expect(classifyServerStatus('error')).toEqual({ kind: 'unknown' });
  });

  it('GroupMeta sans deletedAt -> active', () => {
    const meta: GroupMeta = { groupId: 'g1', name: 'Equipe', deletedAt: null };
    expect(classifyServerStatus(meta)).toEqual({ kind: 'active', meta });
  });

  it('GroupMeta avec deletedAt -> tombstone', () => {
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

  // ── Gardes prioritaires (court-circuitent l'etat serveur) ──
  it('deja removed -> keep (suppression manuelle, jamais re-purge)', () => {
    expect(decideAbsentGroupFate(make({ lifecycle: 'removed' })).action).toBe('keep');
  });

  it('removed a la priorite meme sur un serveur absent', () => {
    const fate = decideAbsentGroupFate(
      make({ lifecycle: 'removed', serverStatus: { kind: 'absent' } })
    );
    expect(fate.action).toBe('keep');
  });

  // ── absent confirme ──
  it('absent confirme -> purge', () => {
    expect(decideAbsentGroupFate(make({ serverStatus: { kind: 'absent' } })).action).toBe('purge');
  });

  // ── doute reseau ──
  it('unknown (reseau) -> keep (jamais de purge sur un doute)', () => {
    expect(decideAbsentGroupFate(make({ serverStatus: { kind: 'unknown' } })).action).toBe('keep');
  });

  // ── tombstone ──
  it('tombstone + active -> markRemoved (banniere)', () => {
    expect(
      decideAbsentGroupFate(make({ serverStatus: tombstone(), lifecycle: 'active' })).action
    ).toBe('markRemoved');
  });

  it('tombstone + placeholder (pending) -> keep', () => {
    expect(
      decideAbsentGroupFate(make({ serverStatus: tombstone(), lifecycle: 'pending' })).action
    ).toBe('keep');
  });

  // ── active (anti-race membership) ──
  it('active + membres indisponibles (null) -> keep (doute)', () => {
    expect(
      decideAbsentGroupFate(make({ serverStatus: active(), isStillUserMember: null })).action
    ).toBe('keep');
  });

  it('active + toujours membre -> keep (snapshot perime)', () => {
    expect(
      decideAbsentGroupFate(make({ serverStatus: active(), isStillUserMember: true })).action
    ).toBe('keep');
  });

  it('active + plus membre + lifecycle active -> markRemoved (exclusion)', () => {
    expect(
      decideAbsentGroupFate(
        make({ serverStatus: active(), isStillUserMember: false, lifecycle: 'active' })
      ).action
    ).toBe('markRemoved');
  });

  it('active + plus membre + placeholder (pending) -> keep', () => {
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

  it('keeps a group this session already registered as a seed carrier, without asking', () => {
    expect(
      decideAbsentLocalGroupFate({
        isKnownDistributionGroup: true,
        serverStatus: { kind: 'absent' },
      })
    ).toEqual({
      action: 'keep',
      reason: 'community key-distribution group, not a conversation',
    });
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

  it('forgets a conversation whose dm_groups row is confirmed gone', () => {
    expect(
      decideAbsentLocalGroupFate({
        isKnownDistributionGroup: false,
        serverStatus: { kind: 'absent' },
      }).action
    ).toBe('forget');
  });

  it('forgets a conversation row we hold no membership in - the behaviour the sweep always had', () => {
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
});

describe('reconcileAbsentLocalGroup', () => {
  const makeMls = (status: 'absent' | 'error' | GroupMeta, known = false) => ({
    isDistributionGroup: vi.fn().mockReturnValue(known),
    getGroupServerStatus: vi.fn().mockResolvedValue(status),
    registerDistributionGroup: vi.fn(),
  });

  it('asks nothing when the group is already registered', async () => {
    const mls = makeMls('absent', true);
    expect((await reconcileAbsentLocalGroup(mls, 'd-1')).action).toBe('keep');
    expect(mls.getGroupServerStatus).not.toHaveBeenCalled();
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
  });
});
