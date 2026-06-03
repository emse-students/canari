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

  it('connects, publie les KeyPackages et envoie welcome_request pour les groupes absents', async () => {
    // g-in-wasm : dans le WASM → pas de welcome_request
    // g-not-in-wasm : dans le serveur mais pas dans WASM → welcome_request
    // g-orphan : dans le WASM mais plus sur le serveur → forgetGroup
    const mls = {
      connect: vi.fn().mockResolvedValue(undefined),
      fetchPendingMessages: vi.fn().mockResolvedValue(undefined),
      onDisconnect: vi.fn(),
      sendDisconnect: vi.fn(),
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      getLocalGroups: vi.fn().mockReturnValue(['g-in-wasm', 'g-orphan']),
      forgetGroup: vi.fn(),
      saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
      sendWelcomeRequest: vi.fn().mockResolvedValue(undefined),
      getUserGroups: vi.fn().mockResolvedValue([
        { groupId: 'g-in-wasm', name: 'InWasm', isGroup: true },
        { groupId: 'g-not-in-wasm', name: 'NotInWasm', isGroup: true },
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

    expect(mls.connect).toHaveBeenCalledWith('jwt-access-token');
    expect(setIsWsConnected).toHaveBeenCalledWith(true);
    expect(mls.generateKeyPackage).toHaveBeenCalledWith('pin1');
    // Groupe absent du WASM → welcome_request
    expect(mls.sendWelcomeRequest).toHaveBeenCalledWith('g-not-in-wasm');
    // Groupe dans le WASM → pas de welcome_request
    expect(mls.sendWelcomeRequest).not.toHaveBeenCalledWith('g-in-wasm');
    // Groupe absent du serveur → forgetGroup
    expect(mls.forgetGroup).toHaveBeenCalledWith('g-orphan');
    expect(mls.saveState).toHaveBeenCalledWith('pin1');
    expect(sync).toHaveBeenCalled();
  });

  it('purge le WASM et ne tente pas de welcome pour les groupes supprimés (deletedAt)', async () => {
    const mls = {
      connect: vi.fn().mockResolvedValue(undefined),
      fetchPendingMessages: vi.fn().mockResolvedValue(undefined),
      onDisconnect: vi.fn(),
      sendDisconnect: vi.fn(),
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      getLocalGroups: vi.fn().mockReturnValue(['g-deleted']),
      forgetGroup: vi.fn(),
      saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
      sendWelcomeRequest: vi.fn().mockResolvedValue(undefined),
      getUserGroups: vi.fn().mockResolvedValue([
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

    // Groupe supprimé et dans WASM → forgetGroup
    expect(mls.forgetGroup).toHaveBeenCalledWith('g-deleted');
    // Pas de welcome_request pour un groupe supprimé
    expect(mls.sendWelcomeRequest).not.toHaveBeenCalled();
    // État muté → saveState appelé
    expect(mls.saveState).toHaveBeenCalledWith('pin1');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('WASM retiré'));
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
