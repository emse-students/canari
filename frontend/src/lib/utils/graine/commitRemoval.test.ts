import type { ChannelService } from '$lib/services/ChannelService';
import { channelScope } from '$lib/mls-client/distributionScope';
import { commitRemovalNow, commitSalonRevoke } from './commitRemoval';

/**
 * THE ACTOR OF A REMOVAL COMMITS IT (channel-encryption section 10). A revoke used to be committed
 * only by a later app load's roster pass, so the device that had just revoked somebody - holding the
 * group, online - committed nothing while it stayed loaded. These pin who commits, and every case in
 * which this device must commit NOTHING and say why.
 */

const reconcile = vi.hoisted(() => vi.fn());
vi.mock('./rosterReconcile', () => ({ reconcileDistributionGroupRoster: reconcile }));

const leadership = vi.hoisted(() => ({ value: 'leader' as string }));
vi.mock('$lib/mls-client/tabLeader', () => ({ getTabLeadership: () => leadership.value }));

const runtime = vi.hoisted(() => ({
  ready: true,
  held: true,
  scope: null as unknown,
}));
vi.mock('./runtime', () => ({
  isGraineReady: () => runtime.ready,
  rawChannelId: (id: string) => String(id).replace(/^channel_/, ''),
  scopeForChannel: () => runtime.scope,
  requireGraineRuntime: () => ({
    mlsService: {
      distributionGroupFor: () => (runtime.held ? 'kg-salon' : null),
      getLocalGroups: () => (runtime.held ? ['kg-salon'] : []),
    },
  }),
}));
vi.mock('$lib/utils/chat/groupUsability', () => ({
  holdsGroupState: (mls: { getLocalGroups: () => string[] }, id: string) =>
    mls.getLocalGroups().includes(id),
}));

const channels = {} as ChannelService;
const salon = channelScope('ws-1', 'chan-1');
let lines: string[];
const log = (m: string) => lines.push(m);

beforeEach(() => {
  lines = [];
  reconcile.mockReset().mockResolvedValue(['bob']);
  leadership.value = 'leader';
  runtime.ready = true;
  runtime.held = true;
  runtime.scope = salon;
});

describe('commitRemovalNow', () => {
  it('runs the scope roster pass from this device when it holds the group', async () => {
    await expect(commitRemovalNow(channels, salon, 'access revoked', log)).resolves.toEqual({
      kind: 'ran',
      removedUserIds: ['bob'],
    });
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(channels, salon, log);
  });

  it('commits nothing on a tab that is not the leader, and says so', async () => {
    for (const state of ['follower', 'undecided']) {
      leadership.value = state;
      lines = [];
      await expect(commitRemovalNow(channels, salon, 'access revoked', log)).resolves.toEqual({
        kind: 'not-leader',
      });
      expect(lines.join(' | ')).toContain(`not the leader tab (${state})`);
    }
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('commits nothing when this device holds no key group for the scope, and says so', async () => {
    runtime.held = false;
    await expect(commitRemovalNow(channels, salon, 'access revoked', log)).resolves.toEqual({
      kind: 'not-held',
    });
    expect(reconcile).not.toHaveBeenCalled();
    expect(lines.join(' | ')).toContain("a holder's next roster pass removes them");
  });

  it('commits nothing before a Graine session is wired', async () => {
    runtime.ready = false;
    await expect(commitRemovalNow(channels, salon, 'access revoked', log)).resolves.toEqual({
      kind: 'no-runtime',
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('never throws into the gesture: a failing pass is reported', async () => {
    reconcile.mockRejectedValue(new Error('boom'));
    await expect(commitRemovalNow(channels, salon, 'access revoked', log)).resolves.toEqual({
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
