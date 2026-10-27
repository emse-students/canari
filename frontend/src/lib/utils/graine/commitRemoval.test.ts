import type { ChannelService } from '$lib/services/ChannelService';
import { channelScope, workspaceScope } from '$lib/mls-client/distributionScope';
import {
  commitCommunityKick,
  commitRemovalNow,
  commitSalonRevoke,
  committingDeviceId,
} from './commitRemoval';

/**
 * THE ACTOR OF A REMOVAL COMMITS IT (channel-encryption section 10). A revoke used to be committed
 * only by a later app load's roster pass, so the device that had just revoked somebody - holding the
 * group, online - committed nothing while it stayed loaded. These pin who commits, and every case in
 * which this device must commit NOTHING and say why.
 */

const reconcile = vi.hoisted(() => vi.fn());
vi.mock('./rosterReconcile', () => ({ reconcileDistributionGroupRosterReported: reconcile }));

const leadership = vi.hoisted(() => ({ value: 'leader' as string }));
vi.mock('$lib/mls-client/tabLeader', () => ({ getTabLeadership: () => leadership.value }));

const runtime = vi.hoisted(() => ({
  ready: true,
  held: true,
  scope: null as unknown,
  scopes: [] as unknown[],
}));
vi.mock('./runtime', () => ({
  isGraineReady: () => runtime.ready,
  rawChannelId: (id: string) => String(id).replace(/^channel_/, ''),
  scopeForChannel: () => runtime.scope,
  requireGraineRuntime: () => ({
    mlsService: {
      distributionGroupFor: () => (runtime.held ? 'kg-salon' : null),
      getLocalGroups: () => (runtime.held ? ['kg-salon'] : []),
      distributionScopes: () => runtime.scopes,
      getDeviceId: () => 'web-self',
    },
  }),
}));
vi.mock('$lib/utils/chat/groupUsability', () => ({
  holdsGroupState: (mls: { getLocalGroups: () => string[] }, id: string) =>
    mls.getLocalGroups().includes(id),
}));

const releaseRemoval = vi.fn();
const channels = { releaseRemoval } as unknown as ChannelService;
const salon = channelScope('ws-1', 'chan-1');
let lines: string[];
const log = (m: string) => lines.push(m);

beforeEach(() => {
  lines = [];
  // The pass removed bob: he holds no leaf of the tree it left.
  reconcile.mockReset().mockResolvedValue({ removedUserIds: ['bob'], heldUserIds: ['alice'] });
  releaseRemoval.mockReset().mockResolvedValue(undefined);
  leadership.value = 'leader';
  runtime.ready = true;
  runtime.held = true;
  runtime.scope = salon;
  runtime.scopes = [];
});

describe('commitRemovalNow', () => {
  it('runs the scope roster pass from this device when it holds the group', async () => {
    await expect(commitRemovalNow(channels, salon, 'bob', 'access revoked', log)).resolves.toEqual({
      kind: 'ran',
      removedUserIds: ['bob'],
      released: false,
    });
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(channels, salon, log);
    expect(releaseRemoval).not.toHaveBeenCalled();
  });

  it('RELEASES the Remove when its pass proves it did not commit it - he still holds a leaf', async () => {
    // Nothing staged, or a definite refusal: the tree the pass left still holds him.
    reconcile.mockResolvedValue({ removedUserIds: [], heldUserIds: ['alice', 'bob'] });
    await expect(commitRemovalNow(channels, salon, 'Bob', 'access revoked', log)).resolves.toEqual({
      kind: 'ran',
      removedUserIds: [],
      released: true,
    });
    expect(releaseRemoval).toHaveBeenCalledExactlyOnceWith(salon, 'Bob');
    expect(lines.join(' | ')).toContain('released to the scope');
  });

  it('releases NOTHING while a commit of its pass has an unknown outcome - it may yet land', async () => {
    reconcile.mockResolvedValue({ removedUserIds: [], heldUserIds: null });
    await expect(commitRemovalNow(channels, salon, 'bob', 'access revoked', log)).resolves.toEqual({
      kind: 'ran',
      removedUserIds: [],
      released: false,
    });
    expect(releaseRemoval).not.toHaveBeenCalled();
    expect(lines.join(' | ')).toContain('not released');
  });

  it('says so when the release itself is refused, and never throws', async () => {
    reconcile.mockResolvedValue({ removedUserIds: [], heldUserIds: ['bob'] });
    releaseRemoval.mockRejectedValue(new Error('503'));
    await expect(commitRemovalNow(channels, salon, 'bob', 'access revoked', log)).resolves.toEqual({
      kind: 'ran',
      removedUserIds: [],
      released: false,
    });
    expect(lines.join(' | ')).toContain('the release was NOT announced');
  });

  it('commits nothing on a tab that is not the leader, and says so', async () => {
    for (const state of ['follower', 'undecided']) {
      leadership.value = state;
      lines = [];
      await expect(
        commitRemovalNow(channels, salon, 'bob', 'access revoked', log)
      ).resolves.toEqual({
        kind: 'not-leader',
      });
      expect(lines.join(' | ')).toContain(`not the leader tab (${state})`);
    }
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('commits nothing when this device holds no key group for the scope, and says so', async () => {
    runtime.held = false;
    await expect(commitRemovalNow(channels, salon, 'bob', 'access revoked', log)).resolves.toEqual({
      kind: 'not-held',
    });
    expect(reconcile).not.toHaveBeenCalled();
    expect(lines.join(' | ')).toContain("a holder's next roster pass removes them");
  });

  it('commits nothing before a Graine session is wired', async () => {
    runtime.ready = false;
    await expect(commitRemovalNow(channels, salon, 'bob', 'access revoked', log)).resolves.toEqual({
      kind: 'no-runtime',
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('never throws into the gesture: a failing pass is reported', async () => {
    reconcile.mockRejectedValue(new Error('boom'));
    await expect(commitRemovalNow(channels, salon, 'bob', 'access revoked', log)).resolves.toEqual({
      kind: 'failed',
    });
    expect(lines.join(' | ')).toContain('the roster pass FAILED (Error: boom)');
  });
});

describe('commitSalonRevoke', () => {
  it("commits in the salon's own scope, as this session registered it", async () => {
    await commitSalonRevoke(channels, 'channel_chan-1', 'bob', log);
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(channels, salon, log);
  });

  it('commits nothing for a salon this session never registered as private', async () => {
    runtime.scope = null;
    await expect(commitSalonRevoke(channels, 'chan-9', 'bob', log)).resolves.toEqual({
      kind: 'unknown-scope',
    });
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe('commitCommunityKick', () => {
  it("commits in the community's group, then in each private salon of THAT community held here", async () => {
    runtime.scopes = [
      workspaceScope('ws-1'),
      salon,
      channelScope('ws-1', 'chan-2'),
      channelScope('ws-other', 'chan-3'),
    ];

    const outcomes = await commitCommunityKick(channels, 'ws-1', 'bob', log);

    // The kick strips every salon's access in the same server call, so each group owes a Remove.
    expect(reconcile.mock.calls.map((c) => c[1])).toEqual([
      workspaceScope('ws-1'),
      salon,
      channelScope('ws-1', 'chan-2'),
    ]);
    expect(outcomes).toHaveLength(3);
  });

  it('asks no salon when the community pass was refused for a reason every salon shares', async () => {
    leadership.value = 'follower';
    runtime.scopes = [salon];

    await expect(commitCommunityKick(channels, 'ws-1', 'bob', log)).resolves.toEqual([
      { kind: 'not-leader' },
    ]);
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe('committingDeviceId', () => {
  it('names this device only when it will commit: a runtime and the leader tab', () => {
    expect(committingDeviceId()).toBe('web-self');
    leadership.value = 'follower';
    expect(committingDeviceId()).toBeUndefined();
    leadership.value = 'leader';
    runtime.ready = false;
    expect(committingDeviceId()).toBeUndefined();
  });
});
