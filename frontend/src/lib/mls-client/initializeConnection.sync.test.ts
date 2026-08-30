vi.mock('$lib/mls-client/tabLeader', () => ({
  getIsTabLeader: () => true,
}));

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: showToastMock }));

import { syncConnectionAfterWsOpen } from './initializeConnection';
import { DeviceLimitReachedError } from './mlsDeliveryApi';
import { workspaceScope } from '$lib/mls-client/distributionScope';

/**
 * The two halves of forgetting a group, as `BaseMlsService` really implements them.
 *
 * EVERY STUB HERE GETS BOTH. The sweep drops a group through `forgetDistributionGroupById`, which
 * erases the tree AND the note classifying it; a stub carrying only `forgetGroup` turns that call
 * into a `TypeError`, which `forgetMlsGroupIfPresent` catches - so every `not.toHaveBeenCalled()`
 * below would pass for the wrong reason, and the anti-purge-storm rules these cases exist to guard
 * would stop being guarded at all.
 */
function forgetPair() {
  const forgetGroup = vi.fn();
  return {
    forgetGroup,
    forgetDistributionGroupById: vi.fn((groupId: string) => {
      forgetGroup(groupId);
      return true;
    }),
  };
}

describe('syncConnectionAfterWsOpen (orphan MLS cleanup)', () => {
  // No fake timers here any more: the 500 ms sleep this used to advance past is gone, replaced by
  // `waitForMessageQueueIdle`. Advancing a clock that nothing reads would only hide a real one.
  it('does not forget or log when ineligible group is already absent from WASM', async () => {
    const mls = {
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      getUserGroups: vi.fn().mockResolvedValue([
        {
          groupId: 'g-deleted',
          name: 'Deleted',
          isGroup: true,
          deletedAt: '2026-01-01T00:00:00Z',
        },
      ]),
      getDeviceMemberships: vi
        .fn()
        .mockResolvedValue([{ status: 'pending', groupId: 'g-deleted' }]),
      getLocalGroups: vi.fn().mockReturnValue([]),
      ...forgetPair(),
      saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
      getDeviceId: vi.fn().mockReturnValue('dev-1'),
      // No distribution group here: `reconcileGroup` asks this before anything else,
      // because a seed carrier has no history to reconcile.
      isDistributionGroup: vi.fn().mockReturnValue(false),
      waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
    };
    const log = vi.fn();

    const done = syncConnectionAfterWsOpen({
      mlsService: mls as any,
      userId: 'u1',
      deviceKeyB64: 'pin1',
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      log,
    });
    await done;

    expect(mls.forgetGroup).not.toHaveBeenCalled();
    expect(mls.saveState).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Skip recovery'));
  });

  it('does not purge local WASM groups when getUserGroups fails (server unavailable)', async () => {
    // Regression: a CD redeploy makes getUserGroups unavailable. Without a guardrail,
    // step 3 would forget all local groups -> re-add storm via SYNC_WATCHDOG.
    const mls = {
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      reconcilePublishedKeyPackages: vi.fn().mockResolvedValue(undefined),
      getUserGroups: vi.fn().mockRejectedValue(new Error('getUserGroups failed: 503')),
      getLocalGroups: vi.fn().mockReturnValue(['g-live-1', 'g-live-2']),
      ...forgetPair(),
      saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
      getDeviceId: vi.fn().mockReturnValue('dev-1'),
      // No distribution group here: `reconcileGroup` asks this before anything else,
      // because a seed carrier has no history to reconcile.
      isDistributionGroup: vi.fn().mockReturnValue(false),
      waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
    };
    const log = vi.fn();

    const done = syncConnectionAfterWsOpen({
      mlsService: mls as any,
      userId: 'u1',
      deviceKeyB64: 'pin1',
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      log,
      onGroupMissing: vi.fn().mockResolvedValue(undefined),
    });
    await done;

    expect(mls.forgetGroup).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('WASM purge skipped'));
  });

  it('does not purge when getUserGroups returns empty but local groups exist (transient)', async () => {
    const mls = {
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      reconcilePublishedKeyPackages: vi.fn().mockResolvedValue(undefined),
      getUserGroups: vi.fn().mockResolvedValue([]),
      getLocalGroups: vi.fn().mockReturnValue(['g-live-1']),
      ...forgetPair(),
      saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
      getDeviceId: vi.fn().mockReturnValue('dev-1'),
      // No distribution group here: `reconcileGroup` asks this before anything else,
      // because a seed carrier has no history to reconcile.
      isDistributionGroup: vi.fn().mockReturnValue(false),
      waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
    };
    const log = vi.fn();

    const done = syncConnectionAfterWsOpen({
      mlsService: mls as any,
      userId: 'u1',
      deviceKeyB64: 'pin1',
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      log,
    });
    await done;

    expect(mls.forgetGroup).not.toHaveBeenCalled();
  });
  // ── WP-GRAINE-1 (prod, 2026-08-19) ──────────────────────────────────────────
  // `getUserGroups` answers for CONVERSATIONS and excludes a community's Graine
  // key-distribution group by construction, so that group is in `getLocalGroups()` and never in
  // the server list. This sweep used to read the absence as "no longer yours" and forget it on
  // every single connection, checkpointing the loss - after which nobody could send in any
  // community, because sealing needs the distribution group in hand.
  it('keeps a distribution group the server list can never name', async () => {
    const mls = {
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      reconcilePublishedKeyPackages: vi.fn().mockResolvedValue(undefined),
      getUserGroups: vi
        .fn()
        .mockResolvedValue([{ groupId: 'g-live', name: 'Equipe', isGroup: true }]),
      getLocalGroups: vi.fn().mockReturnValue(['g-live', 'd-dist']),
      isDistributionGroup: vi.fn().mockReturnValue(false),
      getGroupServerStatus: vi
        .fn()
        .mockResolvedValue({ groupId: 'd-dist', distributionWorkspaceId: 'ws-1' }),
      registerDistributionGroup: vi.fn(),
      ...forgetPair(),
      saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
      getDeviceId: vi.fn().mockReturnValue('dev-1'),
      waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
    };
    const log = vi.fn();

    await syncConnectionAfterWsOpen({
      mlsService: mls as any,
      userId: 'u1',
      deviceKeyB64: 'pin1',
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      log,
    });

    expect(mls.forgetGroup).not.toHaveBeenCalled();
    // The sweep is also how a cold boot learns the mapping, before any community has loaded.
    expect(mls.registerDistributionGroup).toHaveBeenCalledWith(workspaceScope('ws-1'), 'd-dist');
  });

  it('still forgets a conversation whose dm_groups row is confirmed gone', async () => {
    const mls = {
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      reconcilePublishedKeyPackages: vi.fn().mockResolvedValue(undefined),
      getUserGroups: vi
        .fn()
        .mockResolvedValue([{ groupId: 'g-live', name: 'Equipe', isGroup: true }]),
      getLocalGroups: vi.fn().mockReturnValue(['g-live', 'g-orphan']),
      isDistributionGroup: vi.fn().mockReturnValue(false),
      getGroupServerStatus: vi.fn().mockResolvedValue('absent'),
      registerDistributionGroup: vi.fn(),
      ...forgetPair(),
      saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
      getDeviceId: vi.fn().mockReturnValue('dev-1'),
      waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
    };
    const log = vi.fn();

    await syncConnectionAfterWsOpen({
      mlsService: mls as any,
      userId: 'u1',
      deviceKeyB64: 'pin1',
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      log,
    });

    expect(mls.forgetGroup).toHaveBeenCalledWith('g-orphan');
    expect(mls.forgetGroup).not.toHaveBeenCalledWith('g-live');
  });

  /**
   * The regression of 2026-08-30: a group born while the server list was in flight.
   *
   * `getLocalGroups` used to be read AFTER the awaited `getUserGroups`, so a group created during
   * that fetch entered the comparison against a list that could not possibly name it. Its
   * `dm_groups` row is `active` and carries no distribution scope, which is the reducer's `forget`
   * branch - so the sweep destroyed the only copy of a group milliseconds old, and its creator
   * then answered `welcome_request` with `Group not found` for twenty minutes.
   *
   * The stub reproduces the ONLY thing that matters: what the local set contains depends on whether
   * the fetch has begun. Reading it first is what makes the group invisible to this sweep.
   */
  it('does NOT forget a group created while the server list was being fetched', async () => {
    let theFetchHasStarted = false;
    const mls = {
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      reconcilePublishedKeyPackages: vi.fn().mockResolvedValue(undefined),
      getUserGroups: vi.fn().mockImplementation(async () => {
        theFetchHasStarted = true;
        return [{ groupId: 'g-live', name: 'Equipe', isGroup: true }];
      }),
      getLocalGroups: vi
        .fn()
        .mockImplementation(() =>
          theFetchHasStarted ? ['g-live', 'g-born-during-the-fetch'] : ['g-live']
        ),
      isDistributionGroup: vi.fn().mockReturnValue(false),
      // A live conversation row: exactly the shape the reducer forgets on.
      getGroupServerStatus: vi.fn().mockResolvedValue({ deletedAt: null }),
      registerDistributionGroup: vi.fn(),
      noteDistributionGroup: vi.fn(),
      ...forgetPair(),
      saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
      getDeviceId: vi.fn().mockReturnValue('dev-1'),
      waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
    };

    await syncConnectionAfterWsOpen({
      mlsService: mls as any,
      userId: 'u1',
      deviceKeyB64: 'pin1',
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
    });

    expect(mls.forgetGroup).not.toHaveBeenCalledWith('g-born-during-the-fetch');
    expect(mls.forgetGroup).not.toHaveBeenCalled();
  });

  it('keeps an orphan whose status could not be read - doubt is never a licence to destroy', async () => {
    const mls = {
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      reconcilePublishedKeyPackages: vi.fn().mockResolvedValue(undefined),
      getUserGroups: vi
        .fn()
        .mockResolvedValue([{ groupId: 'g-live', name: 'Equipe', isGroup: true }]),
      getLocalGroups: vi.fn().mockReturnValue(['g-live', 'g-orphan']),
      isDistributionGroup: vi.fn().mockReturnValue(false),
      getGroupServerStatus: vi.fn().mockResolvedValue('error'),
      registerDistributionGroup: vi.fn(),
      ...forgetPair(),
      saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
      getDeviceId: vi.fn().mockReturnValue('dev-1'),
      waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
    };

    await syncConnectionAfterWsOpen({
      mlsService: mls as any,
      userId: 'u1',
      deviceKeyB64: 'pin1',
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
    });

    expect(mls.forgetGroup).not.toHaveBeenCalled();
  });
});

/**
 * What the client says when the server refuses this device outright.
 *
 * A 502 is deferred to the next connection and the device heals; the per-user device cap is refused
 * with a 400 every time, forever, and nothing heals. Both used to print the same line. Measured on
 * prod 2026-08-28: an account at 15/15 published no KeyPackage, was answered `no_key_package` on
 * every membership activation, and reported a deferral each reconnection - so the one actor who
 * could fix it was never told.
 */
describe('syncConnectionAfterWsOpen (a refused device is not a deferred one)', () => {
  /** Minimal stub: the KeyPackage step is the whole subject, so nothing after it needs to run. */
  const refusingStub = (error: Error) => ({
    generateKeyPackage: vi.fn().mockRejectedValue(error),
    reconcilePublishedKeyPackages: vi.fn().mockResolvedValue(undefined),
    getUserGroups: vi.fn().mockResolvedValue([]),
    getLocalGroups: vi.fn().mockReturnValue([]),
    isDistributionGroup: vi.fn().mockReturnValue(false),
    registerDistributionGroup: vi.fn(),
    ...forgetPair(),
    saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
    getDeviceId: vi.fn().mockReturnValue('dev-1'),
    waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => showToastMock.mockClear());

  it('names the device cap as a refusal and tells the user, who is the only one who can lift it', async () => {
    const log = vi.fn();
    await syncConnectionAfterWsOpen({
      mlsService: refusingStub(new DeviceLimitReachedError(15)) as any,
      userId: 'u1',
      deviceKeyB64: 'pin1',
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      log,
    });

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('REFUSED') && l.includes('15'))).toBe(true);
    // The word that made this defect invisible for as long as it lasted.
    expect(lines.some((l) => l.includes('deferred to next connection'))).toBe(false);
    expect(showToastMock).toHaveBeenCalledTimes(1);
  });

  it('still defers a transport failure, which the next connection really can fix', async () => {
    const log = vi.fn();
    await syncConnectionAfterWsOpen({
      mlsService: refusingStub(new Error('502 Bad Gateway')) as any,
      userId: 'u1',
      deviceKeyB64: 'pin1',
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      log,
    });

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('deferred to next connection'))).toBe(true);
    // Nothing for the user to do about a 502, so nothing is said to them.
    expect(showToastMock).not.toHaveBeenCalled();
  });
});
