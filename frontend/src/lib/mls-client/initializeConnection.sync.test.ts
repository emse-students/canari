vi.mock('$lib/mls-client/tabLeader', () => ({
  getIsTabLeader: () => true,
}));

import { syncConnectionAfterWsOpen } from './initializeConnection';

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
      forgetGroup: vi.fn(),
      saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
      getDeviceId: vi.fn().mockReturnValue('dev-1'),
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
      forgetGroup: vi.fn(),
      saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
      getDeviceId: vi.fn().mockReturnValue('dev-1'),
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
      forgetGroup: vi.fn(),
      saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
      getDeviceId: vi.fn().mockReturnValue('dev-1'),
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
});
