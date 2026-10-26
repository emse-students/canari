// @vitest-environment happy-dom
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: { isMessageCatchupActive: false, resetMessageCatchupState: vi.fn() },
}));
vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));
// The inviter's own notice resolves names: a profile read nothing here is about.
vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  resolveDisplayNames: async () => (id: string) => id,
}));
vi.mock('$lib/utils/hex', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/hex')>()),
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

import { inviteMembersToGroup } from './groupCreation';
import { processPendingInvitations } from './actions';
import { CommitRefusedError } from '$lib/mls-client/CommitRefusedError';
import { decodeAppMessage } from '$lib/proto/codec';
import { TransportFailureError } from '$lib/utils/transportFailure';

/**
 * AN ADD THAT LOSES A COMMIT RACE IS REBUILT ON PROVEN PROGRESS, OR SURFACED - NEVER DROPPED (CC-4,
 * 1.4.1 dev campaign, 2026-10-25). W1's leaf refresh took epoch 2 -> 3 while W2's Add of W4 was being
 * validated; the gate refused the Add `concurrent_commit`, `processBulkAddition` answered `failed`,
 * and nothing anywhere tried again. Each case models the gate on a small in-memory tree: an Add
 * refused while the epoch MOVED is staged again on the tree that won, one refused with no progress
 * comes back as its own typed reason, and a sweep's row stays pending for the next sweep.
 */
const G = 'g1';

/**
 * The group as one member holds it, the tree and the epoch moving as the gate makes them - plus the
 * server's commit log past the local epoch (`serverAhead`, applied in order by a replay) and whether
 * that log can be read at all.
 */
function group(tree: string[] = ['w2:dev-2', 'w1:dev-1']) {
  return {
    epoch: 2,
    tree,
    serverAhead: [] as Array<(tree: string[]) => string[]>,
    logUnreadable: false,
  };
}

/** The confirmation an Add's tree goes through (`readConfirmedTree`), on the in-memory group. */
function confirmable(state: ReturnType<typeof group>) {
  return {
    runUnderMlsLock: vi.fn((fn: () => Promise<unknown>) => fn()),
    fetchCommitsSince: vi.fn(async (_g: string, since: number) => {
      if (state.logUnreadable) throw new Error('commit log unreachable');
      return {
        commits: state.serverAhead.map((_, i) => ({ baseEpoch: since + i, proto: 'AQID' })),
        activeEpoch: state.epoch + state.serverAhead.length,
        belowFloor: false,
      };
    }),
    settleUnresolvedCommitFromLog: vi.fn(async () => 'none'),
    notifyCommitsApplied: vi.fn(),
    processIncomingMessage: vi.fn(async () => {
      const next = state.serverAhead.shift();
      if (next) state.tree = next(state.tree);
      state.epoch += 1;
      return null;
    }),
  };
}

const without = (user: string) => (tree: string[]) =>
  tree.filter((leaf) => !leaf.startsWith(`${user}:`));

function inviteHarness() {
  const state = group();
  /** The server's roster, read before each rebuild (`rosterPremise`). */
  const roster = new Set(['w1', 'w2']);
  const mlsService = {
    ...confirmable(state),
    getGroupUserMembers: vi.fn(async () => [...roster].map((userId) => ({ userId }))),
    getEpoch: vi.fn(() => state.epoch),
    getGroupMemberIdentities: vi.fn(async () => [...state.tree]),
    registerMember: vi.fn(async () => {}),
    fetchUserDevices: vi.fn(async (u: string) => [
      { deviceId: `${u}-dev`, keyPackage: new Uint8Array([4]) },
    ]),
    acquireAddLock: vi.fn(async () => true),
    releaseAddLock: vi.fn(async () => {}),
    renewAddLock: vi.fn(async () => 'renewed' as const),
    addMembersBulk: vi.fn(
      async (_g: string, devices: Array<{ userId: string; deviceId: string }>) => {
        state.tree.push(...devices.map((d) => `${d.userId}:${d.deviceId}`));
        state.epoch += 1;
        return {
          addedDeviceIds: devices.map((d) => d.deviceId),
          skipped: [],
          welcome: new Uint8Array([1]),
        };
      }
    ),
    sendWelcome: vi.fn(async () => {}),
    sendMessage: vi.fn(async (_g: string, _bytes: Uint8Array) => {}),
    getDeviceId: vi.fn(() => 'dev-2'),
  };
  const deps = {
    mlsService: mlsService as never,
    storage: null,
    userId: 'w2',
    deviceKeyB64: 'k',
    historyBaseUrl: 'https://example.invalid',
    conversations: new SvelteMap(),
    selectConversation: vi.fn(),
    saveConversation: vi.fn(async () => {}),
    /** Where the inviter writes its own `memberAdded` row (`sendVisibleNotice`). */
    addMessageToChat: vi.fn(async (..._args: unknown[]) => {}),
    log: vi.fn(),
  };
  return { state, roster, mlsService, deps };
}

describe('inviteMembersToGroup - a lost commit race', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('CC-4: refused concurrent_commit while the refresh landed - REBUILT, and the joiner is seated', async () => {
    const h = inviteHarness();
    const real = h.mlsService.addMembersBulk.getMockImplementation()!;
    h.mlsService.addMembersBulk.mockImplementationOnce(async () => {
      // W1's leaf refresh won epoch 2; the refusal's catch-up applied it (2 -> 3).
      h.state.epoch = 3;
      throw new CommitRefusedError('concurrent_commit', 2, 2);
    });
    h.mlsService.addMembersBulk.mockImplementationOnce(real);

    const outcome = await inviteMembersToGroup(['w4'], { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'added', addedUsers: ['w4'] });
    expect(h.mlsService.addMembersBulk).toHaveBeenCalledTimes(2);
    expect(h.state.tree).toContain('w4:w4-dev');
    expect(h.mlsService.sendWelcome).toHaveBeenCalledTimes(1);
    // ONE notice for the rebuilt Add, and the inviter holds it under the frame's minted id.
    expect(h.mlsService.sendMessage).toHaveBeenCalledTimes(1);
    const frame = decodeAppMessage(h.mlsService.sendMessage.mock.calls[0][1]);
    expect(frame?.system?.event).toBe('memberAdded');
    expect(h.deps.addMessageToChat).toHaveBeenCalledTimes(1);
    expect(h.deps.addMessageToChat.mock.calls[0][3]).toMatchObject({ messageId: frame?.messageId });
  });

  it('a race refusal that moved nothing is NOT dropped as `failed` - it answers commit-race-lost', async () => {
    const h = inviteHarness();
    h.mlsService.addMembersBulk.mockRejectedValue(
      new CommitRefusedError('concurrent_commit', 2, 2)
    );

    const outcome = await inviteMembersToGroup(['w4'], { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'not-added', reason: 'commit-race-lost' });
    // No proof of progress, no second attempt.
    expect(h.mlsService.addMembersBulk).toHaveBeenCalledTimes(1);
    expect(h.state.tree).not.toContain('w4:w4-dev');
  });

  it('commits nothing when the commit that won had already admitted every invited device', async () => {
    const h = inviteHarness();
    h.mlsService.addMembersBulk.mockImplementationOnce(async () => {
      h.state.tree.push('w4:w4-dev');
      h.state.epoch = 3;
      throw new CommitRefusedError('epoch_mismatch', 2, 3);
    });

    const outcome = await inviteMembersToGroup(['w4'], { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'added', addedUsers: ['w4'] });
    expect(h.mlsService.addMembersBulk).toHaveBeenCalledTimes(1);
    expect(h.mlsService.sendWelcome).not.toHaveBeenCalled();
  });

  it('B2: a rebuild over a concurrent Remove of the SAME person stops - the removal is never undone', async () => {
    const h = inviteHarness();
    // Approving w4's ask: their seat is on the roster when the invitation begins.
    h.roster.add('w4');
    h.mlsService.addMembersBulk.mockImplementationOnce(async () => {
      // Another member declined w4 meanwhile: the roster row went, and their commit took the epoch.
      h.roster.delete('w4');
      h.state.epoch = 3;
      throw new CommitRefusedError('epoch_mismatch', 2, 3);
    });

    const outcome = await inviteMembersToGroup(['w4'], { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'not-added', reason: 'removed-meanwhile' });
    expect(h.mlsService.addMembersBulk).toHaveBeenCalledTimes(1);
    expect(h.state.tree).not.toContain('w4:w4-dev');
    expect(h.mlsService.registerMember).not.toHaveBeenCalledWith(G, 'w4');
    // Abandoned before its stage: nothing announced, and no row of the inviter's own.
    expect(h.mlsService.sendMessage).not.toHaveBeenCalled();
    expect(h.deps.addMessageToChat).not.toHaveBeenCalled();
  });

  it('B3: a device a STALE tree still shows is not filtered - the tree is caught up, and the Add is made', async () => {
    const h = inviteHarness();
    // This device never applied the Remove that took w4's device out: its tree still shows it.
    h.state.tree.push('w4:w4-dev');
    h.state.serverAhead.push(without('w4'));

    const outcome = await inviteMembersToGroup(['w4'], { id: G } as never, h.deps as never);

    expect(h.mlsService.processIncomingMessage).toHaveBeenCalledTimes(1);
    expect(h.mlsService.addMembersBulk).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'added', addedUsers: ['w4'] });
    expect(h.mlsService.sendWelcome).toHaveBeenCalledTimes(1);
  });

  it('B3: a tree that cannot be confirmed never answers `added` for people nobody added', async () => {
    const h = inviteHarness();
    h.state.tree.push('w4:w4-dev');
    h.state.logUnreadable = true;

    const outcome = await inviteMembersToGroup(['w4'], { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'not-added', reason: 'tree-unconfirmed' });
    expect(h.mlsService.addMembersBulk).not.toHaveBeenCalled();
  });

  it('a busy add lock is answered as its own reason, never as an Add', async () => {
    const h = inviteHarness();
    h.mlsService.acquireAddLock.mockResolvedValue(false);

    const outcome = await inviteMembersToGroup(['w4'], { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'not-added', reason: 'add-lock-busy' });
    expect(h.mlsService.addMembersBulk).not.toHaveBeenCalled();
  });

  it('an acquire NOTHING answered is `unreachable`, never a busy lock (NET-3)', async () => {
    const h = inviteHarness();
    h.mlsService.acquireAddLock.mockRejectedValue(
      new TransportFailureError(new TypeError('Failed to fetch'))
    );

    const outcome = await inviteMembersToGroup(['w4'], { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'not-added', reason: 'unreachable' });
    expect(h.mlsService.addMembersBulk).not.toHaveBeenCalled();
  });

  it('EACH REBUILD RENEWS THE LOCK FIRST - and the first attempt, right after the acquire, does not', async () => {
    const h = inviteHarness();
    const order: string[] = [];
    const real = h.mlsService.addMembersBulk.getMockImplementation()!;
    h.mlsService.renewAddLock.mockImplementation(async () => {
      order.push('renew');
      return 'renewed';
    });
    h.mlsService.addMembersBulk.mockImplementationOnce(async () => {
      order.push('stage 1');
      h.state.epoch = 3;
      throw new CommitRefusedError('concurrent_commit', 2, 2);
    });
    h.mlsService.addMembersBulk.mockImplementationOnce(async (g, devices) => {
      order.push('stage 2');
      return real(g, devices);
    });

    const outcome = await inviteMembersToGroup(['w4'], { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'added', addedUsers: ['w4'] });
    expect(order).toEqual(['stage 1', 'renew', 'stage 2']);
    expect(h.mlsService.renewAddLock).toHaveBeenCalledWith(G);
  });

  it('a lock that ran out under the rebuild ENDS the Add before any stage - answered as a busy lock', async () => {
    const h = inviteHarness();
    h.mlsService.renewAddLock.mockResolvedValue('lost' as never);
    h.mlsService.addMembersBulk.mockImplementationOnce(async () => {
      h.state.epoch = 3;
      throw new CommitRefusedError('concurrent_commit', 2, 2);
    });

    const outcome = await inviteMembersToGroup(['w4'], { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'not-added', reason: 'add-lock-busy' });
    expect(h.mlsService.addMembersBulk).toHaveBeenCalledTimes(1);
    expect(h.state.tree).not.toContain('w4:w4-dev');
    // Its release is still sent: the server's line then says released=false, the true trace.
    expect(h.mlsService.releaseAddLock).toHaveBeenCalledWith(G);
  });

  it.each([
    ['a server that predates the renewal', 'unsupported'],
    ['an Add made without a lock', 'not-held'],
  ] as const)('%s renews nothing and the rebuild goes on', async (_n, answer) => {
    const h = inviteHarness();
    h.mlsService.renewAddLock.mockResolvedValue(answer as never);
    const real = h.mlsService.addMembersBulk.getMockImplementation()!;
    h.mlsService.addMembersBulk.mockImplementationOnce(async () => {
      h.state.epoch = 3;
      throw new CommitRefusedError('concurrent_commit', 2, 2);
    });
    h.mlsService.addMembersBulk.mockImplementationOnce(real);

    const outcome = await inviteMembersToGroup(['w4'], { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'added', addedUsers: ['w4'] });
  });
});

function readyConversation(id: string): Conversation {
  return { id, contactName: id, name: 'g', messages: [], lifecycle: 'active' } as never;
}

/** A sweep of one pending row: a device of `w4`, a user the tree already holds. */
function sweepHarness() {
  const state = group(['w2:dev-2', 'w4:old-phone']);
  const mlsService = {
    ...confirmable(state),
    getDeviceId: vi.fn(() => 'dev-2'),
    getEpoch: vi.fn(() => state.epoch),
    getLocalGroups: vi.fn(() => [G]),
    getPendingInvitations: vi
      .fn()
      .mockResolvedValue([{ userId: 'w4', deviceId: 'w4-new', groupId: G, status: 'pending' }]),
    acquireAddLock: vi.fn(async () => true),
    releaseAddLock: vi.fn(async () => {}),
    renewAddLock: vi.fn(async () => 'renewed' as const),
    getGroupMembers: vi.fn(async () => []),
    getGroupMemberIdentities: vi.fn(async () => [...state.tree]),
    fetchUserDevices: vi.fn(async () => [{ deviceId: 'w4-new', keyPackage: new Uint8Array([4]) }]),
    getDeviceMemberships: vi.fn(async () => []),
    deleteDeviceMembership: vi.fn(async () => {}),
    pinnedSignatureKeys: vi.fn(async () => ({ keys: [], anchored: false, reaffirmations: 0 })),
    addMember: vi.fn(async () => {
      state.tree.push('w4:w4-new');
      state.epoch += 1;
      return { welcome: new Uint8Array([9]), ratchetTree: new Uint8Array([8]) };
    }),
    registerMember: vi.fn(async () => {}),
    sendWelcome: vi.fn(async () => {}),
    updateInvitationStatus: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
  };
  const run = () =>
    processPendingInvitations({
      mlsService: mlsService as unknown as IMlsService,
      storage: null,
      userId: 'w2',
      deviceKeyB64: 'k',
      conversations: new Map([[G, readyConversation(G)]]),
      requestReAdd: () => Promise.resolve(),
      log: vi.fn(),
    });
  return { state, mlsService, run };
}

describe('processPendingInvitations - a lost commit race', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('rebuilds the pending Add on proven progress, and the device is Welcomed', async () => {
    const h = sweepHarness();
    const real = h.mlsService.addMember.getMockImplementation()!;
    h.mlsService.addMember.mockImplementationOnce(async () => {
      h.state.epoch = 3;
      throw new CommitRefusedError('concurrent_commit', 2, 2);
    });
    h.mlsService.addMember.mockImplementationOnce(real);

    await h.run();

    expect(h.mlsService.addMember).toHaveBeenCalledTimes(2);
    expect(h.state.tree).toContain('w4:w4-new');
    expect(h.mlsService.sendWelcome).toHaveBeenCalledTimes(1);
  });

  it("a lock that ran out under a rebuild ends the GROUP's pass - no later row is added under it", async () => {
    const h = sweepHarness();
    h.mlsService.getPendingInvitations.mockResolvedValue([
      { userId: 'w4', deviceId: 'w4-new', groupId: G, status: 'pending' },
      { userId: 'w4', deviceId: 'w4-tab', groupId: G, status: 'pending' },
    ]);
    h.mlsService.fetchUserDevices.mockResolvedValue([
      { deviceId: 'w4-new', keyPackage: new Uint8Array([4]) },
      { deviceId: 'w4-tab', keyPackage: new Uint8Array([5]) },
    ]);
    h.mlsService.renewAddLock.mockResolvedValue('lost' as never);
    h.mlsService.addMember.mockImplementationOnce(async () => {
      h.state.epoch = 3;
      throw new CommitRefusedError('concurrent_commit', 2, 2);
    });

    await h.run();

    expect(h.mlsService.addMember).toHaveBeenCalledTimes(1);
    expect(h.mlsService.registerMember).not.toHaveBeenCalled();
    expect(h.mlsService.releaseAddLock).toHaveBeenCalledWith(G);
  });

  it('an acquire nothing answered skips the group, said as no answer - never as a lock held elsewhere', async () => {
    const h = sweepHarness();
    h.mlsService.acquireAddLock.mockRejectedValue(
      new TransportFailureError(new TypeError('Failed to fetch'))
    );

    await h.run();

    expect(h.mlsService.addMember).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('the add lock could not be asked for (no answer)')
    );
  });

  it('a race with no progress leaves the row PENDING for the next sweep - never retired', async () => {
    const h = sweepHarness();
    h.mlsService.addMember.mockRejectedValue(new CommitRefusedError('concurrent_commit', 2, 2));

    await h.run();

    expect(h.mlsService.addMember).toHaveBeenCalledTimes(1);
    expect(h.mlsService.deleteDeviceMembership).not.toHaveBeenCalled();
    expect(h.mlsService.updateInvitationStatus).not.toHaveBeenCalled();
    // Read as the race it is: the sweep asks whether the invitation was fulfilled meanwhile.
    expect(h.mlsService.getDeviceMemberships).toHaveBeenCalledWith('w4', 'w4-new');
  });

  it('B1: the commit that won REMOVED the person - the rebuild stops, nothing staged or registered', async () => {
    const h = sweepHarness();
    h.mlsService.addMember.mockImplementationOnce(async () => {
      // An admin's Remove of w4 took the epoch; the refusal's catch-up applied it.
      h.state.tree = without('w4')(h.state.tree);
      h.state.epoch = 3;
      throw new CommitRefusedError('epoch_mismatch', 2, 3);
    });

    await h.run();

    expect(h.mlsService.addMember).toHaveBeenCalledTimes(1);
    expect(h.state.tree).not.toContain('w4:w4-new');
    expect(h.mlsService.registerMember).not.toHaveBeenCalled();
    expect(h.mlsService.sendWelcome).not.toHaveBeenCalled();
  });

  it('B1: the pending row was withdrawn meanwhile (the record of a removal) - the rebuild stops', async () => {
    const h = sweepHarness();
    h.mlsService.addMember.mockImplementationOnce(async () => {
      // The removal's record landed (the row is gone); its commit is not applied here yet.
      h.mlsService.getPendingInvitations.mockResolvedValue([]);
      h.state.epoch = 3;
      throw new CommitRefusedError('epoch_mismatch', 2, 3);
    });

    await h.run();

    expect(h.mlsService.addMember).toHaveBeenCalledTimes(1);
    expect(h.mlsService.registerMember).not.toHaveBeenCalled();
    expect(h.mlsService.sendWelcome).not.toHaveBeenCalled();
  });

  it('B1: a tree BEHIND the Remove of the person is caught up before the first stage - no Add', async () => {
    const h = sweepHarness();
    h.state.serverAhead.push(without('w4'));

    await h.run();

    expect(h.mlsService.processIncomingMessage).toHaveBeenCalledTimes(1);
    expect(h.mlsService.addMember).not.toHaveBeenCalled();
    expect(h.mlsService.registerMember).not.toHaveBeenCalled();
  });

  it('C3: rows judged at one epoch share ONE commit-log read, and each re-reads the pending list', async () => {
    const h = sweepHarness();
    const rows = [
      { userId: 'w4', deviceId: 'w4-a', groupId: G, status: 'pending' },
      { userId: 'w4', deviceId: 'w4-b', groupId: G, status: 'pending' },
    ];
    h.mlsService.getPendingInvitations.mockResolvedValue(rows);
    h.mlsService.fetchUserDevices.mockResolvedValue([
      { deviceId: 'w4-a', keyPackage: new Uint8Array([4]) },
      { deviceId: 'w4-b', keyPackage: new Uint8Array([5]) },
    ]);
    // Neither Add lands, so both rows are judged at the same epoch.
    h.mlsService.addMember.mockRejectedValue(new Error('boom'));

    await h.run();

    expect(h.mlsService.addMember).toHaveBeenCalledTimes(2);
    // The tree is confirmed ONCE for the pass; the pending list is read again for EVERY row - the
    // sweep's own listing, then one per attempt (a removal deletes a row before its commit lands).
    expect(h.mlsService.fetchCommitsSince).toHaveBeenCalledTimes(1);
    expect(h.mlsService.getPendingInvitations).toHaveBeenCalledTimes(3);
  });

  it('a row withdrawn while an earlier row was staged at the SAME epoch is not re-admitted', async () => {
    const h = sweepHarness();
    h.mlsService.getPendingInvitations.mockResolvedValue([
      { userId: 'w4', deviceId: 'w4-a', groupId: G, status: 'pending' },
      { userId: 'w4', deviceId: 'w4-b', groupId: G, status: 'pending' },
    ]);
    h.mlsService.fetchUserDevices.mockResolvedValue([
      { deviceId: 'w4-a', keyPackage: new Uint8Array([4]) },
      { deviceId: 'w4-b', keyPackage: new Uint8Array([5]) },
    ]);
    // Row A's Add fails without moving the epoch; meanwhile a removal's record deletes row B.
    h.mlsService.addMember.mockImplementationOnce(async () => {
      h.mlsService.getPendingInvitations.mockResolvedValue([
        { userId: 'w4', deviceId: 'w4-a', groupId: G, status: 'pending' },
      ]);
      throw new Error('boom');
    });

    await h.run();

    expect(h.mlsService.addMember).toHaveBeenCalledTimes(1);
    expect(h.mlsService.registerMember).not.toHaveBeenCalled();
  });

  it('a busy add lock leaves the row pending - nothing is retired or staged', async () => {
    const h = sweepHarness();
    h.mlsService.acquireAddLock.mockResolvedValue(false);

    await h.run();

    expect(h.mlsService.addMember).not.toHaveBeenCalled();
    expect(h.mlsService.deleteDeviceMembership).not.toHaveBeenCalled();
  });
});
