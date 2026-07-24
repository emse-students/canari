const getTokenMock = vi.hoisted(() => vi.fn(() => Promise.resolve('jwt-access-token')));
const getIsTabLeaderMock = vi.hoisted(() => vi.fn(() => true));

vi.mock('$lib/stores/auth', () => ({
  getToken: () => getTokenMock(),
}));

vi.mock('$lib/mls-client/tabLeader', () => ({
  getIsTabLeader: () => getIsTabLeaderMock(),
  initTabLeadershipAsync: vi.fn(),
  resetTabLeaderStateForTests: vi.fn(),
  getTabLeaderElectionIdForTests: vi.fn(() => 'test-id'),
}));

// Mock persistMlsStateAfterMutation for syncConnectionAfterWsOpen calls.
vi.mock('$lib/utils/chat/groupActions', () => ({
  persistMlsStateAfterMutation: vi.fn().mockResolvedValue(undefined),
}));

// Prevent re-soliciting history from triggering side effects.
vi.mock('$lib/utils/chat/historySolicit', () => ({
  reSolicitAwaitingHistory: vi.fn(),
}));

import { initializeConnection } from './initializeConnection';

describe('initializeConnection (realistic connect + membership sync)', () => {
  beforeEach(() => {
    getTokenMock.mockClear();
    getTokenMock.mockResolvedValue('jwt-access-token');
    getIsTabLeaderMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
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
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Follower tab'));
  });

  it('connects, publie les KeyPackages et réconcilie les groupes', async () => {
    const mls = {
      connect: vi.fn().mockResolvedValue(undefined),
      fetchPendingMessages: vi.fn().mockResolvedValue(undefined),
      onDisconnect: vi.fn(),
      sendDisconnect: vi.fn(),
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      reconcilePublishedKeyPackages: vi.fn().mockResolvedValue(undefined),
      getLocalGroups: vi.fn().mockReturnValue(['g-in-wasm', 'g-orphan']),
      forgetGroup: vi.fn(),
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
    const onGroupMissing = vi.fn().mockResolvedValue(undefined);
    const onGroupDeletedRemotely = vi.fn();

    await initializeConnection({
      mlsService: mls as any,
      userId: 'u1',
      pin: 'pin1',
      scheduleReconnect,
      setIsWsConnected,
      setReconnectAttempts,
      processDeviceInvitationsLocally: sync,
      log,
      onGroupMissing,
      onGroupDeletedRemotely,
    });

    expect(mls.connect).toHaveBeenCalledWith('jwt-access-token');
    expect(setIsWsConnected).toHaveBeenCalledWith(true);
    expect(mls.generateKeyPackage).toHaveBeenCalledWith('pin1');
    // Groupe absent du WASM → onGroupMissing (recovery seam)
    expect(onGroupMissing).toHaveBeenCalledWith('g-not-in-wasm');
    // Groupe dans le WASM → pas de onGroupMissing
    expect(onGroupMissing).not.toHaveBeenCalledWith('g-in-wasm');
    // Groupe absent du serveur → forgetGroup
    expect(mls.forgetGroup).toHaveBeenCalledWith('g-orphan');
    // Pas de sendWelcomeRequest direct (onGroupMissing est fourni)
    expect(mls.sendWelcomeRequest).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Connected to network!'));
  });

  it('purge le WASM et notifie pour les groupes supprimés (deletedAt)', async () => {
    const mls = {
      connect: vi.fn().mockResolvedValue(undefined),
      fetchPendingMessages: vi.fn().mockResolvedValue(undefined),
      onDisconnect: vi.fn(),
      sendDisconnect: vi.fn(),
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      reconcilePublishedKeyPackages: vi.fn().mockResolvedValue(undefined),
      getLocalGroups: vi.fn().mockReturnValue(['g-deleted']),
      forgetGroup: vi.fn(),
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
    const onGroupDeletedRemotely = vi.fn();

    await initializeConnection({
      mlsService: mls as any,
      userId: 'u1',
      pin: 'pin1',
      scheduleReconnect: vi.fn(),
      setIsWsConnected: vi.fn(),
      setReconnectAttempts: vi.fn(),
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      log,
      onGroupDeletedRemotely,
    });

    // Groupe supprimé et dans WASM → forgetGroup
    expect(mls.forgetGroup).toHaveBeenCalledWith('g-deleted');
    // Pas de welcome_request pour un groupe supprimé
    expect(mls.sendWelcomeRequest).not.toHaveBeenCalled();
    // onGroupDeletedRemotely est appelé pour notifier l'UI
    expect(onGroupDeletedRemotely).toHaveBeenCalledWith('g-deleted');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('WASM removed'));
  });

  it('groupe actif absent du WASM → onGroupMissing appelé', async () => {
    const mls = {
      connect: vi.fn().mockResolvedValue(undefined),
      fetchPendingMessages: vi.fn().mockResolvedValue(undefined),
      onDisconnect: vi.fn(),
      sendDisconnect: vi.fn(),
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      reconcilePublishedKeyPackages: vi.fn().mockResolvedValue(undefined),
      getLocalGroups: vi.fn().mockReturnValue([]),
      forgetGroup: vi.fn(),
      sendWelcomeRequest: vi.fn().mockResolvedValue(undefined),
      getUserGroups: vi
        .fn()
        .mockResolvedValue([{ groupId: 'g-live', name: 'Live', isGroup: true }]),
      getDeviceId: vi.fn().mockReturnValue('dev-1'),
    };
    const log = vi.fn();
    const onGroupMissing = vi.fn().mockResolvedValue(undefined);

    await initializeConnection({
      mlsService: mls as any,
      userId: 'u1',
      pin: 'pin1',
      scheduleReconnect: vi.fn(),
      setIsWsConnected: vi.fn(),
      setReconnectAttempts: vi.fn(),
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      log,
      onGroupMissing,
    });

    expect(onGroupMissing).toHaveBeenCalledWith('g-live');
  });

  it('skips membership sync when connect throws', async () => {
    getIsTabLeaderMock.mockReturnValue(true);
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
