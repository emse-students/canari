import type { ChannelService } from '$lib/services/ChannelService';
import { commitDepartureIfElected, electDepartureCommitter } from './departureCommitter';

/**
 * WHO COMMITS A DEPARTURE THE ACTOR CANNOT (channel-encryption section 10). Every receiver of the
 * removal broadcast runs this; exactly one device may commit, and it must be the same one whoever
 * computes it. These pin the election and every case in which this device commits NOTHING.
 */

const reconcile = vi.hoisted(() => vi.fn());
vi.mock('./rosterReconcile', () => ({ reconcileDistributionGroupRoster: reconcile }));

const leadership = vi.hoisted(() => ({ value: 'leader' as string }));
vi.mock('$lib/mls-client/tabLeader', () => ({ getTabLeadership: () => leadership.value }));

const runtime = vi.hoisted(() => ({
  ready: true,
  held: true,
  leaves: [] as string[] | Error,
  scopes: [] as unknown[],
  deviceId: 'dev-a',
}));
vi.mock('./runtime', () => ({
  isGraineReady: () => runtime.ready,
  rawChannelId: (id: string) => String(id).replace(/^channel_/, ''),
  requireGraineRuntime: () => ({
    userId: 'Alice',
    mlsService: {
      distributionGroupFor: () => (runtime.held ? 'kg-1' : null),
      getLocalGroups: () => (runtime.held ? ['kg-1'] : []),
      distributionScopes: () => runtime.scopes,
      getDeviceId: () => runtime.deviceId,
      getGroupMemberIdentities: () =>
        runtime.leaves instanceof Error
          ? Promise.reject(runtime.leaves)
          : Promise.resolve(runtime.leaves),
    },
  }),
}));
vi.mock('$lib/utils/chat/groupUsability', () => ({
  holdsGroupState: (mls: { getLocalGroups: () => string[] }, id: string) =>
    mls.getLocalGroups().includes(id),
}));

let rosterRows: unknown[];
const channels = {
  listWorkspaceMembers: vi.fn(() => Promise.resolve(rosterRows)),
  listMembers: vi.fn(() => Promise.resolve(rosterRows)),
} as unknown as ChannelService;
let lines: string[];
const log = (m: string) => lines.push(m);

const salonLeave = {
  workspaceId: 'ws-1',
  channelId: 'chan-1',
  channelIsPrivate: true,
  departedUserId: 'bob',
  actorUserId: 'bob',
};

beforeEach(() => {
  lines = [];
  vi.mocked(channels.listMembers).mockClear();
  vi.mocked(channels.listWorkspaceMembers).mockClear();
  reconcile.mockReset().mockResolvedValue(['bob']);
  leadership.value = 'leader';
  runtime.ready = true;
  runtime.held = true;
  runtime.leaves = ['alice:dev-a', 'carol:dev-c', 'bob:dev-b'];
  runtime.scopes = [];
  runtime.deviceId = 'dev-a';
  rosterRows = [
    { userId: 'alice', onlineDevices: ['dev-a'] },
    { userId: 'carol', onlineDevices: ['dev-c'] },
  ];
});

describe('electDepartureCommitter', () => {
  it('elects the first online remaining leaf in canonical order, whatever the input order', () => {
    const rows = [
      { userId: 'Carol', onlineDevices: ['dev-c'] },
      { userId: 'alice', onlineDevices: ['dev-a2'] },
    ];
    const a = electDepartureCommitter({
      leafIdentities: ['carol:dev-c', 'alice:dev-a1', 'alice:dev-a2'],
      rosterRows: rows,
      departedUserId: 'bob',
    });
    const b = electDepartureCommitter({
      leafIdentities: ['alice:dev-a2', 'alice:dev-a1', 'carol:dev-c'],
      rosterRows: [...rows].reverse(),
      departedUserId: 'bob',
    });
    expect(a).toBe('alice:dev-a2');
    expect(b).toBe(a);
  });

  it('never elects the departed user, nor an offline device, nor a user off the roster', () => {
    expect(
      electDepartureCommitter({
        leafIdentities: ['aaron:dev-0', 'bob:dev-b', 'carol:dev-c1', 'carol:dev-c2'],
        rosterRows: [
          { userId: 'Bob', onlineDevices: ['dev-b'] },
          { userId: 'carol', onlineDevices: ['dev-c2'] },
        ],
        departedUserId: 'BOB',
      })
    ).toBe('carol:dev-c2');
  });

  it('elects nobody from a roster that carries no per-device presence', () => {
    expect(
      electDepartureCommitter({
        leafIdentities: ['carol:dev-c'],
        rosterRows: [{ userId: 'carol', onlineDevices: ['dev-c'] }, { userId: 'dan' }],
        departedUserId: 'bob',
      })
    ).toBeNull();
  });

  it('elects nobody when no remaining device is online', () => {
    expect(
      electDepartureCommitter({
        leafIdentities: ['carol:dev-c'],
        rosterRows: [{ userId: 'carol', onlineDevices: [] }],
        departedUserId: 'bob',
      })
    ).toBeNull();
  });
});

describe('commitDepartureIfElected', () => {
  it('runs the salon roster pass when this device is the one elected', async () => {
    await expect(commitDepartureIfElected(channels, salonLeave, log)).resolves.toEqual([
      'elected-here',
    ]);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(lines.join('\n')).toContain('this device is elected - committing it');
  });

  it('commits nothing when another device is elected, and names it', async () => {
    runtime.deviceId = 'dev-z';
    await expect(commitDepartureIfElected(channels, salonLeave, log)).resolves.toEqual([
      'elected-elsewhere',
    ]);
    expect(reconcile).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('alice:dev-a is elected');
  });

  it('leaves it to the actor when the actor holds a leaf', async () => {
    await expect(
      commitDepartureIfElected(channels, { ...salonLeave, actorUserId: 'Carol' }, log)
    ).resolves.toEqual(['actor-commits']);
    expect(reconcile).not.toHaveBeenCalled();
    expect(channels.listMembers).not.toHaveBeenCalled();
  });

  it('elects among the members when the actor holds no leaf', async () => {
    await expect(
      commitDepartureIfElected(channels, { ...salonLeave, actorUserId: 'admin' }, log)
    ).resolves.toEqual(['elected-here']);
  });

  it('commits nothing and says so when nobody can be elected', async () => {
    rosterRows = [{ userId: 'alice', onlineDevices: [] }];
    await expect(commitDepartureIfElected(channels, salonLeave, log)).resolves.toEqual([
      'nobody-elected',
    ]);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('commits nothing from a tab that is not the leader', async () => {
    leadership.value = 'follower';
    await expect(commitDepartureIfElected(channels, salonLeave, log)).resolves.toEqual([
      'not-leader',
    ]);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('reports an unreadable tree instead of throwing', async () => {
    runtime.leaves = new Error('boom');
    await expect(commitDepartureIfElected(channels, salonLeave, log)).resolves.toEqual([
      'unreadable',
    ]);
    expect(lines.join('\n')).toContain('could not be read');
  });

  it('decides nothing for a group it does not hold, nor without a runtime', async () => {
    runtime.held = false;
    await expect(commitDepartureIfElected(channels, salonLeave, log)).resolves.toEqual([
      'not-held',
    ]);
    runtime.ready = false;
    await expect(commitDepartureIfElected(channels, salonLeave, log)).resolves.toEqual([
      'no-runtime',
    ]);
  });

  it('has no key group to decide for on a public salon', async () => {
    await expect(
      commitDepartureIfElected(channels, { ...salonLeave, channelIsPrivate: false }, log)
    ).resolves.toEqual([]);
  });

  it('decides a community departure for the community and its held salons only', async () => {
    runtime.scopes = [
      { kind: 'channel', workspaceId: 'ws-1', channelId: 'chan-1' },
      { kind: 'channel', workspaceId: 'ws-2', channelId: 'chan-9' },
      { kind: 'workspace', workspaceId: 'ws-1' },
    ];
    const decisions = await commitDepartureIfElected(
      channels,
      { ...salonLeave, channelId: '', channelIsPrivate: false },
      log
    );
    expect(decisions).toEqual(['elected-here', 'elected-here']);
    expect(channels.listWorkspaceMembers).toHaveBeenCalledWith('ws-1', { presence: true });
    expect(channels.listMembers).toHaveBeenCalledWith('chan-1', 'channel', { presence: true });
  });
});
