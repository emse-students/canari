import type { ChannelService } from '$lib/services/ChannelService';
import {
  ELECTION_WINDOW,
  commitDepartureIfElected,
  commitReleasedDepartureIfElected,
  electDepartureCommitter,
  electionWindow,
  windowOffset,
} from './departureCommitter';

/**
 * WHO COMMITS A DEPARTURE THE ACTOR CANNOT (channel-encryption section 10). Every receiver of the
 * removal broadcast runs this; exactly one device may commit, and it must be the same one whoever
 * computes it. These pin the election, the actor's claim and its release, and every case in which
 * this device commits NOTHING.
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
  epoch: 7,
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
      getEpoch: () => runtime.epoch,
      // The tree and its epoch are read together under the lock; a commit merged meanwhile moves it.
      runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
      getGroupMemberIdentities: () =>
        runtime.leaves instanceof Error
          ? Promise.reject(runtime.leaves)
          : Promise.resolve(runtime.leaves),
    },
  }),
}));
const gap = vi.hoisted(() => ({ groups: new Set<string>() }));
vi.mock('$lib/utils/chat/epochGapRegistry', () => ({
  isInEpochGap: (id: string) => gap.groups.has(id),
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
  runtime.epoch = 7;
  gap.groups = new Set();
  // Only this device is online, so it is elected whatever the window's rotation.
  rosterRows = [
    { userId: 'alice', onlineDevices: ['dev-a'] },
    { userId: 'carol', onlineDevices: [] },
  ];
});

describe('electionWindow', () => {
  const leaves = ['a1:d', 'a2:d', 'a3:d', 'a4:d', 'a5:d', 'a6:d', 'bob:b'];

  it('is the same for every receiver at one epoch, whatever the order the tree lists', () => {
    expect(electionWindow(leaves, 'bob', 7)).toEqual(
      electionWindow([...leaves].reverse(), 'BOB', 7)
    );
    expect(electionWindow(leaves, 'bob', 7)).toHaveLength(ELECTION_WINDOW);
    expect(electionWindow(leaves, 'bob', 7)).not.toContain('bob:b');
  });

  it('starts at the departure-and-epoch offset and wraps around the sorted leaves', () => {
    const sorted = ['a1:d', 'a2:d', 'a3:d', 'a4:d', 'a5:d', 'a6:d'];
    const start = windowOffset('bob', 7, sorted.length);
    const expected = [...sorted.slice(start), ...sorted.slice(0, start)].slice(0, ELECTION_WINDOW);
    expect(electionWindow(leaves, 'bob', 7)).toEqual(expected);
  });

  it('MOVES with the epoch and the departure, so no fixed prefix of leaves starves every election', () => {
    const starts = new Set<number>();
    for (let epoch = 0; epoch < 40; epoch++) starts.add(windowOffset('bob', epoch, 6));
    for (const who of ['carol', 'dan', 'erin', 'fred']) starts.add(windowOffset(who, 7, 6));
    // Every leaf is the first of some window.
    expect(starts.size).toBe(6);
  });
});

describe('electDepartureCommitter', () => {
  it('never elects the departed user, nor an offline device, nor a user off the roster', () => {
    expect(
      electDepartureCommitter({
        leafIdentities: ['aaron:dev-0', 'bob:dev-b', 'carol:dev-c1', 'carol:dev-c2'],
        rosterRows: [
          { userId: 'Bob', onlineDevices: ['dev-b'] },
          { userId: 'carol', onlineDevices: ['dev-c2'] },
        ],
        departedUserId: 'BOB',
        epoch: 3,
      })
    ).toBe('carol:dev-c2');
  });

  it('elects nobody from a roster that carries no per-device presence', () => {
    expect(
      electDepartureCommitter({
        leafIdentities: ['carol:dev-c'],
        rosterRows: [{ userId: 'carol', onlineDevices: ['dev-c'] }, { userId: 'dan' }],
        departedUserId: 'bob',
        epoch: 3,
      })
    ).toBeNull();
  });

  it('elects only within the window, whatever is online beyond it', () => {
    const leaves = ['a1:d', 'a2:d', 'a3:d', 'a4:d', 'a5:d', 'a6:d', 'bob:b'];
    const outside = ['a1:d', 'a2:d', 'a3:d', 'a4:d', 'a5:d', 'a6:d'].find(
      (k) => !electionWindow(leaves, 'bob', 7).includes(k)
    )!;
    expect(
      electDepartureCommitter({
        leafIdentities: leaves,
        rosterRows: [{ userId: outside.split(':')[0], onlineDevices: ['d'] }],
        departedUserId: 'bob',
        epoch: 7,
      })
    ).toBeNull();
  });

  it('two receivers that disagree on presence elect two devices - each runs the one pass', () => {
    // Alice's read saw her own device online; Carol's read a moment later saw Alice offline. The
    // epoch gate keeps one commit; the other pass reads the tree again and says "already gone".
    const leafIdentities = ['alice:dev-a', 'carol:dev-c', 'bob:dev-b'];
    const aliceView = electDepartureCommitter({
      leafIdentities,
      rosterRows: [
        { userId: 'alice', onlineDevices: ['dev-a'] },
        { userId: 'carol', onlineDevices: [] },
      ],
      departedUserId: 'bob',
      epoch: 7,
    });
    const carolView = electDepartureCommitter({
      leafIdentities,
      rosterRows: [
        { userId: 'alice', onlineDevices: [] },
        { userId: 'carol', onlineDevices: ['dev-c'] },
      ],
      departedUserId: 'bob',
      epoch: 7,
    });
    expect(aliceView).toBe('alice:dev-a');
    expect(carolView).toBe('carol:dev-c');
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

  it('decides nothing when the departed user holds no leaf in the scope', async () => {
    runtime.leaves = ['alice:dev-a', 'carol:dev-c'];
    await expect(commitDepartureIfElected(channels, salonLeave, log)).resolves.toEqual([
      'not-in-tree',
    ]);
    expect(channels.listMembers).not.toHaveBeenCalled();
  });

  it('commits nothing when another device is elected, and names it', async () => {
    rosterRows = [
      { userId: 'alice', onlineDevices: [] },
      { userId: 'carol', onlineDevices: ['dev-c'] },
    ];
    await expect(commitDepartureIfElected(channels, salonLeave, log)).resolves.toEqual([
      'elected-elsewhere',
    ]);
    expect(reconcile).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('carol:de is elected');
  });

  it('leaves it to the actor when the actor DEVICE holds a leaf', async () => {
    await expect(
      commitDepartureIfElected(
        channels,
        { ...salonLeave, actorUserId: 'Carol', actorDeviceId: 'dev-c' },
        log
      )
    ).resolves.toEqual(['actor-commits']);
    expect(reconcile).not.toHaveBeenCalled();
    expect(channels.listMembers).not.toHaveBeenCalled();
  });

  it('elects when the actor user holds a leaf but the acting device does not', async () => {
    await expect(
      commitDepartureIfElected(
        channels,
        { ...salonLeave, actorUserId: 'carol', actorDeviceId: 'dev-c-phone' },
        log
      )
    ).resolves.toEqual(['elected-here']);
  });

  it('elects when the actor named no committing device (an older client, a follower tab)', async () => {
    await expect(
      commitDepartureIfElected(channels, { ...salonLeave, actorUserId: 'carol' }, log)
    ).resolves.toEqual(['elected-here']);
  });

  it('commits nothing and says so - from each window member - when nobody can be elected', async () => {
    rosterRows = [{ userId: 'alice', onlineDevices: [] }];
    await expect(commitDepartureIfElected(channels, salonLeave, log)).resolves.toEqual([
      'nobody-elected',
    ]);
    expect(reconcile).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('nobody elected');
  });

  it('does not even read the roster from a device outside the election window', async () => {
    runtime.leaves = [
      'aa:d',
      'ab:d',
      'ac:d',
      'ad:d',
      'ae:d',
      'af:d',
      'ag:d',
      'alice:dev-a',
      'bob:b',
    ];
    // An epoch whose window leaves this device out.
    runtime.epoch = [...Array(200).keys()].find(
      (e) => !electionWindow(runtime.leaves as string[], 'bob', e).includes('alice:dev-a')
    )!;
    await expect(commitDepartureIfElected(channels, salonLeave, log)).resolves.toEqual([
      'outside-window',
    ]);
    expect(channels.listMembers).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('commits nothing from a tab that is not the leader', async () => {
    leadership.value = 'follower';
    await expect(commitDepartureIfElected(channels, salonLeave, log)).resolves.toEqual([
      'not-leader',
    ]);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('commits nothing from an elected device whose group is in an epoch gap', async () => {
    gap.groups = new Set(['kg-1']);
    await expect(commitDepartureIfElected(channels, salonLeave, log)).resolves.toEqual([
      'cannot-commit',
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

describe('a departure left to the actor is decided again ONLY on its release', () => {
  const kickedByCarol = { ...salonLeave, actorUserId: 'carol', actorDeviceId: 'dev-c' };

  it('nothing but the release decides it again - not the next removal broadcast', async () => {
    await commitDepartureIfElected(channels, kickedByCarol, log);
    await commitDepartureIfElected(channels, { ...salonLeave, departedUserId: 'dan' }, log);
    // Dan holds no leaf; Bob's Remove stays Carol's, whose commit may still be in flight.
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('a release elects for the one released scope, without the claim', async () => {
    await expect(
      commitReleasedDepartureIfElected(
        channels,
        { workspaceId: 'ws-1', channelId: 'chan-1', departedUserId: 'bob' },
        log
      )
    ).resolves.toBe('elected-here');
    expect(reconcile).toHaveBeenCalledOnce();
    expect(lines.join(' | ')).toContain('released by the actor');
  });

  it('a community release decides the community only, never its salons', async () => {
    runtime.scopes = [
      { kind: 'channel', workspaceId: 'ws-1', channelId: 'chan-1' },
      { kind: 'workspace', workspaceId: 'ws-1' },
    ];
    await commitReleasedDepartureIfElected(
      channels,
      { workspaceId: 'ws-1', channelId: '', departedUserId: 'bob' },
      log
    );
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile.mock.calls[0][1]).toEqual({ kind: 'workspace', workspaceId: 'ws-1' });
  });

  it('a release about somebody already gone from the tree decides nothing', async () => {
    runtime.leaves = ['alice:dev-a', 'carol:dev-c'];
    await expect(
      commitReleasedDepartureIfElected(
        channels,
        { workspaceId: 'ws-1', channelId: 'chan-1', departedUserId: 'bob' },
        log
      )
    ).resolves.toBe('not-in-tree');
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe('the tree and its epoch are read together', () => {
  it('decides nothing from a tree whose epoch moved while it was read', async () => {
    let reads = 0;
    const original = runtime.epoch;
    // The epoch reads 7 then 8: a commit merged between the two halves of the read.
    Object.defineProperty(runtime, 'epoch', {
      configurable: true,
      get: () => (reads++ === 0 ? original : original + 1),
    });
    try {
      await expect(commitDepartureIfElected(channels, salonLeave, log)).resolves.toEqual([
        'unreadable',
      ]);
      expect(lines.join(' | ')).toContain('the epoch moved 7 -> 8');
      expect(reconcile).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(runtime, 'epoch', {
        configurable: true,
        writable: true,
        enumerable: true,
        value: 7,
      });
    }
  });
});
