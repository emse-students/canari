import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./tabLeader', () => ({
  getIsTabLeader: () => true,
}));

import { syncConnectionAfterWsOpen } from './initializeConnection';

describe('syncConnectionAfterWsOpen (orphan MLS cleanup)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
    };
    const log = vi.fn();

    const done = syncConnectionAfterWsOpen({
      mlsService: mls as any,
      userId: 'u1',
      pin: 'pin1',
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      log,
    });
    await vi.advanceTimersByTimeAsync(600);
    await done;

    expect(mls.forgetGroup).not.toHaveBeenCalled();
    expect(mls.saveState).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Skip recovery'));
  });
});
