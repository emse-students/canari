// @vitest-environment happy-dom
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: { isMessageCatchupActive: false, resetMessageCatchupState: vi.fn() },
}));
vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));
vi.mock('$lib/utils/hex', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/hex')>()),
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

import { inviteMembersToGroup } from './groupCreation';
import { processPendingInvitations } from './actions';
import { CommitRefusedError } from '$lib/mls-client/CommitRefusedError';

/**
 * AN ADD THAT LOSES A COMMIT RACE IS REBUILT ON PROVEN PROGRESS, OR SURFACED - NEVER DROPPED (CC-4,
 * 1.4.1 dev campaign, 2026-10-25). W1's leaf refresh took epoch 2 -> 3 while W2's Add of W4 was being
 * validated; the gate refused the Add `concurrent_commit`, `processBulkAddition` answered `failed`,
 * and nothing anywhere tried again. Each case models the gate on a small in-memory tree: an Add
 * refused while the epoch MOVED is staged again on the tree that won, one refused with no progress
 * comes back as its own typed reason, and a sweep's row stays pending for the next sweep.
 */
const G = 'g1';

/** The group as one member holds it, the tree and the epoch moving as the gate makes them. */
function group() {
  return { epoch: 2, tree: ['w2:dev-2', 'w1:dev-1'] };
}

function inviteHarness() {
  const state = group();
  const mlsService = {
    getEpoch: vi.fn(() => state.epoch),
    getGroupMemberIdentities: vi.fn(async () => [...state.tree]),
    registerMember: vi.fn(async () => {}),
    fetchUserDevices: vi.fn(async (u: string) => [
      { deviceId: `${u}-dev`, keyPackage: new Uint8Array([4]) },
    ]),
    acquireAddLock: vi.fn(async () => true),
    releaseAddLock: vi.fn(async () => {}),
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
    sendMessage: vi.fn(async () => {}),
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
    log: vi.fn(),
  };
  return { state, mlsService, deps };
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

  it('a busy add lock is answered as its own reason, never as an Add', async () => {
    const h = inviteHarness();
    h.mlsService.acquireAddLock.mockResolvedValue(false);

    const outcome = await inviteMembersToGroup(['w4'], { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'not-added', reason: 'add-lock-busy' });
    expect(h.mlsService.addMembersBulk).not.toHaveBeenCalled();
  });
});

function readyConversation(id: string): Conversation {
  return { id, contactName: id, name: 'g', messages: [], lifecycle: 'active' } as never;
}

/** A sweep of one pending row: a device of `w4`, a user the tree already holds. */
function sweepHarness() {
  const state = { epoch: 2, tree: ['w2:dev-2', 'w4:old-phone'] };
  const mlsService = {
    getDeviceId: vi.fn(() => 'dev-2'),
    getEpoch: vi.fn(() => state.epoch),
    getLocalGroups: vi.fn(() => [G]),
    getPendingInvitations: vi
      .fn()
      .mockResolvedValue([{ userId: 'w4', deviceId: 'w4-new', groupId: G, status: 'pending' }]),
    acquireAddLock: vi.fn(async () => true),
    releaseAddLock: vi.fn(async () => {}),
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

  it('a busy add lock leaves the row pending - nothing is retired or staged', async () => {
    const h = sweepHarness();
    h.mlsService.acquireAddLock.mockResolvedValue(false);

    await h.run();

    expect(h.mlsService.addMember).not.toHaveBeenCalled();
    expect(h.mlsService.deleteDeviceMembership).not.toHaveBeenCalled();
  });
});
