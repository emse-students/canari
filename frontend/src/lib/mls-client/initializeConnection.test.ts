import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getTokenMock = vi.hoisted(() => vi.fn(() => Promise.resolve('jwt-access-token')));
const getIsTabLeaderMock = vi.hoisted(() => vi.fn(() => true));

vi.mock('$lib/stores/auth', () => ({
  getToken: () => getTokenMock(),
}));

vi.mock('./tabLeader', () => ({
  getIsTabLeader: () => getIsTabLeaderMock(),
  initTabLeadershipAsync: vi.fn(),
  resetTabLeaderStateForTests: vi.fn(),
  getTabLeaderElectionIdForTests: vi.fn(() => 'test-id'),
}));

import { initializeConnection } from './initializeConnection';

describe('initializeConnection (realistic connect + membership sync)', () => {
  beforeEach(() => {
    getTokenMock.mockClear();
    getTokenMock.mockResolvedValue('jwt-access-token');
    getIsTabLeaderMock.mockReturnValue(true);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('skips entirely when this tab is not the MLS leader', async () => {
    getIsTabLeaderMock.mockReturnValue(false);
    const mls = {
      connect: vi.fn(),
      generateKeyPackage: vi.fn(),
      getDeviceMemberships: vi.fn(),
      getLocalGroups: vi.fn().mockReturnValue([]),
      getUserGroups: vi.fn(),
      getDeviceId: vi.fn().mockReturnValue('d1'),
    };
    const log = vi.fn();
    await initializeConnection({
      mlsService: mls as any,
      userId: 'u1',
      pin: 'p',
      scheduleReconnect: vi.fn(),
      setIsWsConnected: vi.fn(),
      setReconnectAttempts: vi.fn(),
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      log,
    });
    expect(mls.connect).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('follower'));
  });

  it('connects with token, wires disconnect, publishes key package, syncs memberships', async () => {
    const mls = {
      connect: vi.fn().mockResolvedValue(undefined),
      fetchPendingMessages: vi.fn().mockResolvedValue(undefined),
      onDisconnect: vi.fn(),
      sendDisconnect: vi.fn(),
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      getDeviceMemberships: vi.fn().mockResolvedValue([
        { status: 'pending', groupId: 'g-pend' },
        { status: 'stale', groupId: 'g-stale' },
        { status: 'welcome_received', groupId: 'g-miss' },
      ]),
      getLocalGroups: vi.fn().mockReturnValue([]),
      forgetGroup: vi.fn(),
      sendReinviteRequest: vi.fn().mockResolvedValue(undefined),
      sendWelcomeRequest: vi.fn().mockResolvedValue(undefined),
      updateInvitationStatus: vi.fn().mockResolvedValue(undefined),
      getUserGroups: vi.fn().mockResolvedValue([
        { groupId: 'g-pend', name: 'Pend', isGroup: true },
        { groupId: 'g-stale', name: 'Stale', isGroup: true },
        { groupId: 'g-miss', name: 'Miss', isGroup: true },
        { groupId: 'g-orphan', name: 'Orphan', isGroup: true },
      ]),
      getDeviceId: vi.fn().mockReturnValue('dev-1'),
    };
    const setIsWsConnected = vi.fn();
    const setReconnectAttempts = vi.fn();
    const scheduleReconnect = vi.fn();
    const sync = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    const done = initializeConnection({
      mlsService: mls as any,
      userId: 'u1',
      pin: 'pin1',
      scheduleReconnect,
      setIsWsConnected,
      setReconnectAttempts,
      processDeviceInvitationsLocally: sync,
      log,
    });

    await vi.advanceTimersByTimeAsync(600);
    await done;

    expect(getTokenMock).toHaveBeenCalled();
    expect(mls.connect).toHaveBeenCalledWith('jwt-access-token');
    expect(setIsWsConnected).toHaveBeenCalledWith(true);
    expect(setReconnectAttempts).toHaveBeenCalledWith(0);
    expect(mls.onDisconnect).toHaveBeenCalledWith(scheduleReconnect);
    expect(mls.generateKeyPackage).toHaveBeenCalledWith('pin1');
    expect(mls.sendWelcomeRequest).toHaveBeenCalledWith('g-pend');
    expect(mls.forgetGroup).toHaveBeenCalledWith('g-stale');
    expect(mls.sendReinviteRequest).toHaveBeenCalled();
    expect(mls.updateInvitationStatus).toHaveBeenCalled();
    expect(mls.sendWelcomeRequest).toHaveBeenCalledWith('g-orphan');
    expect(sync).toHaveBeenCalled();
  });

  it('does not send reinvite for soft-deleted groups', async () => {
    const mls = {
      connect: vi.fn().mockResolvedValue(undefined),
      fetchPendingMessages: vi.fn().mockResolvedValue(undefined),
      onDisconnect: vi.fn(),
      sendDisconnect: vi.fn(),
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      getDeviceMemberships: vi.fn().mockResolvedValue([{ status: 'stale', groupId: 'g-deleted' }]),
      getLocalGroups: vi.fn().mockReturnValue(['g-deleted']),
      forgetGroup: vi.fn(),
      sendReinviteRequest: vi.fn().mockResolvedValue(undefined),
      sendWelcomeRequest: vi.fn().mockResolvedValue(undefined),
      updateInvitationStatus: vi.fn().mockResolvedValue(undefined),
      getUserGroups: vi
        .fn()
        .mockResolvedValue([
          {
            groupId: 'g-deleted',
            name: 'Deleted',
            isGroup: true,
            deletedAt: '2026-01-01T00:00:00Z',
          },
        ]),
      getDeviceId: vi.fn().mockReturnValue('dev-1'),
    };
    const log = vi.fn();

    const done = initializeConnection({
      mlsService: mls as any,
      userId: 'u1',
      pin: 'pin1',
      scheduleReconnect: vi.fn(),
      setIsWsConnected: vi.fn(),
      setReconnectAttempts: vi.fn(),
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      log,
    });

    await vi.advanceTimersByTimeAsync(600);
    await done;

    expect(mls.sendReinviteRequest).not.toHaveBeenCalled();
    expect(mls.forgetGroup).toHaveBeenCalledWith('g-deleted');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('groupe supprimé'));
  });

  it('skips membership sync when connect throws', async () => {
    const mls = {
      connect: vi.fn().mockRejectedValue(new Error('gateway down')),
      fetchPendingMessages: vi.fn(),
      onDisconnect: vi.fn(),
      sendDisconnect: vi.fn(),
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      getDeviceMemberships: vi.fn().mockResolvedValue([]),
      getLocalGroups: vi.fn().mockReturnValue([]),
      getUserGroups: vi.fn().mockResolvedValue([]),
      getDeviceId: vi.fn().mockReturnValue('d'),
    };
    const log = vi.fn();
    await initializeConnection({
      mlsService: mls as any,
      userId: 'u',
      pin: 'p',
      scheduleReconnect: vi.fn(),
      setIsWsConnected: vi.fn(),
      setReconnectAttempts: vi.fn(),
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      log,
    });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Gateway inaccessible/));
    expect(mls.generateKeyPackage).not.toHaveBeenCalled();
    expect(mls.getDeviceMemberships).not.toHaveBeenCalled();
  });
});
