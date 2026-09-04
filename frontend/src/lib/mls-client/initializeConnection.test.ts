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
// PARTIAL, and deliberately so: only the checkpoint is stubbed (it needs a device key and a real
// store). `forgetMlsGroupIfPresent` stays REAL, because what it drops is the point - forgetting the
// tree while leaving the distribution registration standing is the defect this sweep now depends on
// it not having, and a mocked helper would hide exactly that.
vi.mock('$lib/utils/chat/groupActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/groupActions')>()),
  persistMlsStateAfterMutation: vi.fn().mockResolvedValue(undefined),
}));

// Keep the reconciliation pass out of these cases: it is exercised on its own, and here it would
// only assert that a session which registered no probe sender sends no probe.
// The sweep decision is REAL here, not stubbed: these cases connect a device with no stored
// connection record, which is the "new or restored store" case, so they exercise the branch that
// still sweeps. Stubbing it would let the call site stop consulting it without any test noticing.
// RESOLVES TO THE ASKED GROUP IDS, like the real one: the caller feeds them straight to
// `noteGroupsAudited`, so a mock resolving `undefined` claims a pass asked nothing AND breaks the
// discharge - which is exactly what it did until the audit gave the return value a meaning.
const { reconcileAllGroupsMock } = vi.hoisted(() => ({
  reconcileAllGroupsMock: vi.fn().mockResolvedValue([] as string[]),
}));
vi.mock('$lib/utils/chat/historyReconcile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/historyReconcile')>();
  return { ...actual, reconcileAllGroups: reconcileAllGroupsMock };
});

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
      deviceKeyB64: 'p',
      scheduleReconnect: vi.fn(),
      setIsWsConnected: vi.fn(),
      setReconnectAttempts: vi.fn(),
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      onGroupMissing: vi.fn().mockResolvedValue(undefined),
      log,
    });
    expect(mls.connect).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Follower tab'));
  });

  it('connects, publie les KeyPackages et réconcilie les groupes', async () => {
    // Held outside the literal so the distribution-aware drop below can delegate to it without the
    // object referring to itself in its own initializer.
    const forgetGroup = vi.fn();
    const mls = {
      connect: vi.fn().mockResolvedValue(undefined),
      fetchPendingMessages: vi.fn().mockResolvedValue(undefined),
      onDisconnect: vi.fn(),
      sendDisconnect: vi.fn(),
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      reconcilePublishedKeyPackages: vi.fn().mockResolvedValue(undefined),
      getLocalGroups: vi.fn().mockReturnValue(['g-in-wasm', 'g-orphan']),
      forgetGroup,
      // The drop goes through `forgetDistributionGroupById` now, which drops the tree AND the
      // registration together. Delegating to `forgetGroup` here keeps the assertion below a
      // statement about the tree actually being forgotten rather than about which method was called
      // on the way to it.
      forgetDistributionGroupById: vi.fn((groupId: string) => {
        forgetGroup(groupId);
        return true;
      }),
      // `g-orphan` is absent from the server list AND from `dm_groups`: a real phantom, which is
      // the one case the sweep may still destroy. See `reconcileAbsentLocalGroup`.
      isDistributionGroup: vi.fn().mockReturnValue(false),
      getGroupServerStatus: vi.fn().mockResolvedValue('absent'),
      registerDistributionGroup: vi.fn(),
      sendWelcomeRequest: vi.fn().mockResolvedValue(undefined),
      getUserGroups: vi.fn().mockResolvedValue([
        { groupId: 'g-in-wasm', name: 'InWasm', isGroup: true },
        { groupId: 'g-not-in-wasm', name: 'NotInWasm', isGroup: true },
      ]),
      getDeviceId: vi.fn().mockReturnValue('dev-1'),
      waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
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
      deviceKeyB64: 'pin1',
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
    // Group absent from WASM -> onGroupMissing (recovery seam)
    expect(onGroupMissing).toHaveBeenCalledWith('g-not-in-wasm');
    // Group in WASM -> no onGroupMissing
    expect(onGroupMissing).not.toHaveBeenCalledWith('g-in-wasm');
    // Group absent from server -> forgotten, tree and distribution registration together
    expect(mls.forgetDistributionGroupById).toHaveBeenCalledWith('g-orphan');
    expect(mls.forgetGroup).toHaveBeenCalledWith('g-orphan');
    // No direct sendWelcomeRequest (onGroupMissing is provided)
    expect(mls.sendWelcomeRequest).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Connected to network!'));
  });

  it('announces departure only when the page actually goes away, and only once', async () => {
    // The `disconnect` frame is the whole departure signal, and it must not fire early: the same
    // method is called when the app is merely BACKGROUNDED, where the socket is deliberately kept.
    // A close code once sat next to it here, to stop a dying document reporting 1006; it was
    // measured inert (the gateway breaks its read loop on `disconnect`, so it never reads a close
    // frame) and removed. This test pins what is left - once, and not before unload.
    const mls = {
      connect: vi.fn().mockResolvedValue(undefined),
      fetchPendingMessages: vi.fn().mockResolvedValue(undefined),
      onDisconnect: vi.fn(),
      sendDisconnect: vi.fn(),
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      reconcilePublishedKeyPackages: vi.fn().mockResolvedValue(undefined),
      getLocalGroups: vi.fn().mockReturnValue([]),
      getUserGroups: vi.fn().mockResolvedValue([]),
      getDeviceId: vi.fn().mockReturnValue('dev-1'),
      waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
    };

    await initializeConnection({
      mlsService: mls as any,
      userId: 'u1',
      deviceKeyB64: 'pin1',
      scheduleReconnect: vi.fn(),
      setIsWsConnected: vi.fn(),
      setReconnectAttempts: vi.fn(),
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      onGroupMissing: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
    });

    expect(mls.sendDisconnect).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('beforeunload'));
    expect(mls.sendDisconnect).toHaveBeenCalledTimes(1);

    // `{ once: true }` - a second unload event must not announce a departure twice.
    window.dispatchEvent(new Event('beforeunload'));
    expect(mls.sendDisconnect).toHaveBeenCalledTimes(1);
  });

  it('purges WASM and notifies for deleted groups (deletedAt)', async () => {
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
      waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
    };
    const log = vi.fn();
    const onGroupDeletedRemotely = vi.fn();

    await initializeConnection({
      mlsService: mls as any,
      userId: 'u1',
      deviceKeyB64: 'pin1',
      scheduleReconnect: vi.fn(),
      setIsWsConnected: vi.fn(),
      setReconnectAttempts: vi.fn(),
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      onGroupMissing: vi.fn().mockResolvedValue(undefined),
      log,
      onGroupDeletedRemotely,
    });

    // Deleted group and in WASM -> forgetGroup
    expect(mls.forgetGroup).toHaveBeenCalledWith('g-deleted');
    // No welcome_request for a deleted group
    expect(mls.sendWelcomeRequest).not.toHaveBeenCalled();
    // onGroupDeletedRemotely is called to notify the UI
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
      waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
    };
    const log = vi.fn();
    const onGroupMissing = vi.fn().mockResolvedValue(undefined);

    await initializeConnection({
      mlsService: mls as any,
      userId: 'u1',
      deviceKeyB64: 'pin1',
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
      deviceKeyB64: 'p',
      scheduleReconnect: vi.fn(),
      setIsWsConnected: vi.fn(),
      setReconnectAttempts: vi.fn(),
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      onGroupMissing: vi.fn().mockResolvedValue(undefined),
      log,
    });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Gateway inaccessible/));
    expect(mls.generateKeyPackage).not.toHaveBeenCalled();
    expect(mls.getDeviceMemberships).not.toHaveBeenCalled();
  });
});
