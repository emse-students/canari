// @vitest-environment happy-dom
const getTokenMock = vi.hoisted(() => vi.fn(() => Promise.resolve('jwt-access-token')));
const getIsTabLeaderMock = vi.hoisted(() => vi.fn(() => true));

// The types the catch tests by `instanceof`: plain stand-ins, as the store would pull in the app graph.
const authErrors = vi.hoisted(() => ({
  SessionExpiredError: class SessionExpiredError extends Error {},
  SignOutInProgressError: class SignOutInProgressError extends Error {},
}));
vi.mock('$lib/stores/auth', () => ({
  getToken: () => getTokenMock(),
  ...authErrors,
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
// The store the history records are bound to (`IStorage.messageStoreIncarnation`): one store, the
// same for every connection of a case, unless a case says otherwise.
const { incarnationMock } = vi.hoisted(() => ({
  incarnationMock: vi.fn().mockResolvedValue('store-1' as string | null),
}));
vi.mock('$lib/db', () => ({
  getStorage: async () => ({ messageStoreIncarnation: incarnationMock }),
}));

const { reconcileAllGroupsMock } = vi.hoisted(() => ({
  reconcileAllGroupsMock: vi.fn().mockResolvedValue({ asked: [] as string[], complete: true }),
}));
vi.mock('$lib/utils/chat/historyReconcile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/historyReconcile')>();
  return { ...actual, reconcileAllGroups: reconcileAllGroupsMock };
});

import { initializeConnection, openGatewayConnection } from './initializeConnection';
import { markGroupInCreation } from '$lib/utils/chat/groupsInCreation';
import {
  closeOpenSweep,
  groupsAskedInOpenSweep,
  noteConnection,
  resetAuditRecord,
} from '$lib/utils/chat/historyReconcile';
import { APP_FOREGROUND_EVENT } from '$lib/utils/appForeground';
import { TransportFailureError } from '$lib/utils/transportFailure';

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
      gatewaySocketSettled: vi.fn().mockResolvedValue(undefined),
      socketFence: () => 0,
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
      onCaughtUp: vi.fn(),
      setReconnectAttempts: vi.fn(),
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      onGroupMissing: vi.fn().mockResolvedValue(undefined),
      onStrandedSeat: vi.fn().mockResolvedValue(undefined),
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
      gatewaySocketSettled: vi.fn().mockResolvedValue(undefined),
      socketFence: () => 0,
      settleUnresolvedCommits: vi.fn().mockResolvedValue(undefined),
      isDestroyed: () => false,
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
      forgetDistributionGroupById: vi.fn(async (groupId: string) => {
        forgetGroup(groupId, 0);
        return true;
      }),
      // `g-orphan` is absent from the server list AND from `dm_groups`: a real phantom, which is
      // the one case the sweep may still destroy. See `reconcileAbsentLocalGroup`.
      isDistributionGroup: vi.fn().mockReturnValue(false),
      getGroupServerStatus: vi.fn().mockResolvedValue('absent'),
      registerDistributionGroup: vi.fn(),
      sendWelcomeRequest: vi.fn().mockResolvedValue(null),
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
      onCaughtUp: vi.fn(),
      setReconnectAttempts,
      processDeviceInvitationsLocally: sync,
      log,
      onGroupMissing,
      onStrandedSeat: vi.fn().mockResolvedValue(undefined),
      onGroupDeletedRemotely,
    });

    expect(mls.connect).toHaveBeenCalledWith('jwt-access-token', 0);
    expect(setIsWsConnected).toHaveBeenCalledWith(true);
    expect(mls.generateKeyPackage).toHaveBeenCalledWith('pin1', { fresh: true });
    // Group absent from WASM -> onGroupMissing (recovery seam)
    expect(onGroupMissing).toHaveBeenCalledWith('g-not-in-wasm');
    // Group in WASM -> no onGroupMissing
    expect(onGroupMissing).not.toHaveBeenCalledWith('g-in-wasm');
    // Group absent from server -> forgotten, tree and distribution registration together
    expect(mls.forgetDistributionGroupById).toHaveBeenCalledWith('g-orphan', 'absent from server');
    expect(mls.forgetGroup).toHaveBeenCalledWith('g-orphan', 0);
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
      gatewaySocketSettled: vi.fn().mockResolvedValue(undefined),
      socketFence: () => 0,
      settleUnresolvedCommits: vi.fn().mockResolvedValue(undefined),
      isDestroyed: () => false,
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
      onCaughtUp: vi.fn(),
      setReconnectAttempts: vi.fn(),
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      onGroupMissing: vi.fn().mockResolvedValue(undefined),
      onStrandedSeat: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
    });

    expect(mls.sendDisconnect).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('beforeunload'));
    expect(mls.sendDisconnect).toHaveBeenCalledTimes(1);

    // `{ once: true }` - a second unload event must not announce a departure twice.
    window.dispatchEvent(new Event('beforeunload'));
    expect(mls.sendDisconnect).toHaveBeenCalledTimes(1);
  });

  /**
   * The signal a call answered on the native ring waits for: AFTER the commits are settled and the
   * pending frames fetched, so the call's keys and its answered notice run at the current epoch.
   */
  it('says it caught up only after the commits are settled and the pending frames fetched', async () => {
    const steps: string[] = [];
    const mls = {
      connect: vi.fn().mockResolvedValue(undefined),
      gatewaySocketSettled: vi.fn().mockResolvedValue(undefined),
      socketFence: () => 0,
      settleUnresolvedCommits: vi.fn(async () => {
        steps.push('settle');
      }),
      isDestroyed: () => false,
      fetchPendingMessages: vi.fn(async () => {
        steps.push('fetch');
      }),
      onDisconnect: vi.fn(),
      sendDisconnect: vi.fn(),
    };
    await openGatewayConnection({
      mlsService: mls as any,
      userId: 'u1',
      deviceKeyB64: 'pin1',
      scheduleReconnect: vi.fn(),
      setIsWsConnected: (v: boolean) => steps.push(`connected=${v}`),
      onCaughtUp: () => steps.push('caught-up'),
      setReconnectAttempts: vi.fn(),
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      onGroupMissing: vi.fn().mockResolvedValue(undefined),
      onStrandedSeat: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
    });

    expect(steps).toEqual(['connected=true', 'settle', 'fetch', 'caught-up']);
  });

  it('purges WASM and notifies for deleted groups (deletedAt)', async () => {
    const mls = {
      connect: vi.fn().mockResolvedValue(undefined),
      gatewaySocketSettled: vi.fn().mockResolvedValue(undefined),
      socketFence: () => 0,
      settleUnresolvedCommits: vi.fn().mockResolvedValue(undefined),
      isDestroyed: () => false,
      fetchPendingMessages: vi.fn().mockResolvedValue(undefined),
      onDisconnect: vi.fn(),
      sendDisconnect: vi.fn(),
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      reconcilePublishedKeyPackages: vi.fn().mockResolvedValue(undefined),
      getLocalGroups: vi.fn().mockReturnValue(['g-deleted']),
      forgetGroup: vi.fn(),
      // Asked by the audit, which never owes one for a distribution group.
      isDistributionGroup: vi.fn().mockReturnValue(false),
      sendWelcomeRequest: vi.fn().mockResolvedValue(null),
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
      onCaughtUp: vi.fn(),
      setReconnectAttempts: vi.fn(),
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      onGroupMissing: vi.fn().mockResolvedValue(undefined),
      onStrandedSeat: vi.fn().mockResolvedValue(undefined),
      log,
      onGroupDeletedRemotely,
    });

    // Deleted group and in WASM -> forgetGroup
    expect(mls.forgetGroup).toHaveBeenCalledWith('g-deleted', 0);
    // No welcome_request for a deleted group
    expect(mls.sendWelcomeRequest).not.toHaveBeenCalled();
    // onGroupDeletedRemotely is called to notify the UI
    expect(onGroupDeletedRemotely).toHaveBeenCalledWith('g-deleted');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('WASM removed'));
  });

  it('groupe actif absent du WASM → onGroupMissing appelé', async () => {
    const mls = {
      connect: vi.fn().mockResolvedValue(undefined),
      gatewaySocketSettled: vi.fn().mockResolvedValue(undefined),
      socketFence: () => 0,
      settleUnresolvedCommits: vi.fn().mockResolvedValue(undefined),
      isDestroyed: () => false,
      fetchPendingMessages: vi.fn().mockResolvedValue(undefined),
      onDisconnect: vi.fn(),
      sendDisconnect: vi.fn(),
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      reconcilePublishedKeyPackages: vi.fn().mockResolvedValue(undefined),
      getLocalGroups: vi.fn().mockReturnValue([]),
      forgetGroup: vi.fn(),
      sendWelcomeRequest: vi.fn().mockResolvedValue(null),
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
      onCaughtUp: vi.fn(),
      setReconnectAttempts: vi.fn(),
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      log,
      onGroupMissing,
      onStrandedSeat: vi.fn().mockResolvedValue(undefined),
    });

    expect(onGroupMissing).toHaveBeenCalledWith('g-live');
  });

  it('skips membership sync when connect throws', async () => {
    getIsTabLeaderMock.mockReturnValue(true);
    const mls = {
      connect: vi.fn().mockRejectedValue(new Error('gateway down')),
      gatewaySocketSettled: vi.fn().mockResolvedValue(undefined),
      socketFence: () => 0,
      settleUnresolvedCommits: vi.fn(),
      isDestroyed: () => false,
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
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleError.mockClear();
    await initializeConnection({
      mlsService: mls as any,
      userId: 'u',
      deviceKeyB64: 'p',
      scheduleReconnect: vi.fn(),
      setIsWsConnected: vi.fn(),
      onCaughtUp: vi.fn(),
      setReconnectAttempts: vi.fn(),
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      onGroupMissing: vi.fn().mockResolvedValue(undefined),
      onStrandedSeat: vi.fn().mockResolvedValue(undefined),
      log,
    });
    // One line, accusing: the link was not known down, so the gateway should have answered.
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      '[WS] Gateway connection failed:',
      'Error: gateway down'
    );
    expect(mls.generateKeyPackage).not.toHaveBeenCalled();
    expect(mls.getDeviceMemberships).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // Production 1.5.1: a socket that could not open on an absent link logged twice, once at ERROR.
  it('says a gateway the link could not reach once, as the expected state, never at error', async () => {
    getIsTabLeaderMock.mockReturnValue(true);
    const mls = {
      connect: vi
        .fn()
        .mockRejectedValue(new TransportFailureError('failed to lookup address information')),
      gatewaySocketSettled: vi.fn().mockResolvedValue(undefined),
      socketFence: () => 0,
      onDisconnect: vi.fn(),
    };
    const log = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleError.mockClear();

    const opened = await openGatewayConnection({
      mlsService: mls as any,
      scheduleReconnect: vi.fn(),
      setIsWsConnected: vi.fn(),
      onCaughtUp: vi.fn(),
      setReconnectAttempts: vi.fn(),
      log,
    } as any);

    expect(opened).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('Gateway'));
    expect(lines.filter((l) => l.includes('failed'))).toEqual([
      expect.stringContaining('the link is down'),
    ]);
    consoleError.mockRestore();
  });

  /**
   * A COMMIT WHOSE OUTCOME IS UNKNOWN IS SETTLED BEFORE ANYTHING IS READ. The pending frames may
   * hold the next epoch's traffic, which this device can read only once its own commit is merged -
   * or another member's commit, which clears ours behind the settlement's back. The resubmission
   * answers first, then the queue is drained.
   */
  it('resubmits unresolved commits after connecting and BEFORE draining pending messages', async () => {
    const order: string[] = [];
    const mls = {
      connect: vi.fn(async () => {
        order.push('connect');
      }),
      gatewaySocketSettled: vi.fn().mockResolvedValue(undefined),
      socketFence: () => 0,
      settleUnresolvedCommits: vi.fn(async () => {
        order.push('settle');
      }),
      isDestroyed: () => false,
      fetchPendingMessages: vi.fn(async () => {
        order.push('fetch');
      }),
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
      deviceKeyB64: 'p',
      scheduleReconnect: vi.fn(),
      setIsWsConnected: vi.fn(),
      onCaughtUp: vi.fn(),
      setReconnectAttempts: vi.fn(),
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      onGroupMissing: vi.fn().mockResolvedValue(undefined),
      onStrandedSeat: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
    });
    expect(order).toEqual(['connect', 'settle', 'fetch']);
  });
});

/**
 * A GROUP THIS DEVICE IS CREATING IS NOT ASKED ABOUT BY THE CONNECTION'S HISTORY PASS, IN EITHER MODE.
 *
 * It is local from `createGroup` on, long before the creation ends, and has no past to compare:
 * LEAF-REFRESH-1 (2026-11-16) showed the pass auditing one between its `create_group` and its Add
 * (`no member online ... - will ask when one returns`). The creation's mark is read in the turn the
 * local groups are, before the mode is chosen, so a sweep and an audit both leave it out. What the
 * group owes afterwards is the creation's to settle: recorded on success, still owed on failure.
 */
describe('initializeConnection - the history pass leaves a group being created out', () => {
  function creatingMls() {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      gatewaySocketSettled: vi.fn().mockResolvedValue(undefined),
      socketFence: () => 0,
      settleUnresolvedCommits: vi.fn().mockResolvedValue(undefined),
      isDestroyed: () => false,
      fetchPendingMessages: vi.fn().mockResolvedValue(undefined),
      onDisconnect: vi.fn(),
      sendDisconnect: vi.fn(),
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
      reconcilePublishedKeyPackages: vi.fn().mockResolvedValue(undefined),
      getLocalGroups: vi.fn().mockReturnValue(['g-old', 'g-creating']),
      isDistributionGroup: vi.fn().mockReturnValue(false),
      registerDistributionGroup: vi.fn(),
      getUserGroups: vi.fn().mockResolvedValue([
        { groupId: 'g-old', name: 'Old', isGroup: true },
        { groupId: 'g-creating', name: 'New', isGroup: true },
      ]),
      getDeviceId: vi.fn().mockReturnValue('dev-c'),
      waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
    };
  }

  async function connect(mls: ReturnType<typeof creatingMls>, log = vi.fn()) {
    await initializeConnection({
      mlsService: mls as any,
      userId: 'u-c',
      deviceKeyB64: 'pin',
      scheduleReconnect: vi.fn(),
      setIsWsConnected: vi.fn(),
      onCaughtUp: vi.fn(),
      setReconnectAttempts: vi.fn(),
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      log,
      onGroupMissing: vi.fn().mockResolvedValue(undefined),
      onStrandedSeat: vi.fn().mockResolvedValue(undefined),
    });
    return log;
  }

  beforeEach(() => {
    getIsTabLeaderMock.mockReturnValue(true);
    reconcileAllGroupsMock.mockClear();
    resetAuditRecord('u-c', 'dev-c');
    try {
      localStorage.clear();
    } catch {
      /* happy-dom always has one */
    }
  });

  it('sweep mode (no connection record): every group but the one being created', async () => {
    const release = markGroupInCreation('g-creating');
    try {
      const log = await connect(creatingMls());
      expect(log).toHaveBeenCalledWith(expect.stringContaining('sweeping every group'));
    } finally {
      release();
    }
    expect(reconcileAllGroupsMock).toHaveBeenCalledTimes(1);
    expect(reconcileAllGroupsMock.mock.calls[0][1]).toEqual(['g-old']);
  });

  it('audit mode: the group being created is not owed by this pass', async () => {
    noteConnection('u-c', 'dev-c', Date.now(), 'store-1');
    const release = markGroupInCreation('g-creating');
    try {
      const log = await connect(creatingMls());
      expect(log).toHaveBeenCalledWith(expect.stringContaining('auditing 1 group(s)'));
    } finally {
      release();
    }
    expect(reconcileAllGroupsMock.mock.calls[0][1]).toEqual(['g-old']);
  });

  /**
   * THE RECORDS ARE ABOUT ONE STORE. 2026-11-25: a v23 rebuild lost a device's whole message table,
   * and its connection and audit records - written against the table that was lost - said "nothing
   * to ask", so nothing was. A store made anew carries a new incarnation, and a record of another
   * one is no evidence about it.
   */
  it('a store that is not the one the records were written against sweeps every group, then settles', async () => {
    reconcileAllGroupsMock.mockResolvedValueOnce({
      asked: ['g-old', 'g-creating'],
      complete: true,
    });
    incarnationMock.mockResolvedValue('store-1');
    await connect(creatingMls());
    reconcileAllGroupsMock.mockClear();

    // Same store: nothing owed.
    let log = await connect(creatingMls());
    expect(log).toHaveBeenCalledWith(expect.stringContaining('every group already audited'));
    expect(reconcileAllGroupsMock).not.toHaveBeenCalled();

    // The table was lost and made again: a new incarnation, and every group is asked.
    incarnationMock.mockResolvedValue('store-2');
    log = await connect(creatingMls());
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('not the one the last connection saw')
    );
    expect(reconcileAllGroupsMock.mock.calls[0][1]).toEqual(['g-old', 'g-creating']);
    incarnationMock.mockResolvedValue('store-1');
  });

  it('a sweep cut short is not recorded as done: the next connection sweeps again', async () => {
    incarnationMock.mockResolvedValue('store-cut');
    reconcileAllGroupsMock.mockResolvedValueOnce({ asked: ['g-old'], complete: false });
    await connect(creatingMls());
    expect(reconcileAllGroupsMock).toHaveBeenCalledTimes(1);
    reconcileAllGroupsMock.mockClear();

    const log = await connect(creatingMls());
    expect(log).toHaveBeenCalledWith(expect.stringContaining('sweeping every group'));
    expect(reconcileAllGroupsMock).toHaveBeenCalledTimes(1);
  });

  it('a cut sweep restarts where it stopped: the groups it asked are not asked again', async () => {
    closeOpenSweep('u-c', 'dev-c');
    incarnationMock.mockResolvedValue('store-tail');
    const three = () => {
      const mls = creatingMls();
      mls.getLocalGroups.mockReturnValue(['g-a', 'g-b', 'g-c']);
      return mls;
    };
    reconcileAllGroupsMock.mockResolvedValueOnce({ asked: ['g-a'], complete: false });
    await connect(three());
    expect(reconcileAllGroupsMock.mock.calls[0][1]).toEqual(['g-a', 'g-b', 'g-c']);
    reconcileAllGroupsMock.mockClear();

    // The tail is asked next; the head, already asked, is not.
    reconcileAllGroupsMock.mockResolvedValueOnce({ asked: ['g-b', 'g-c'], complete: true });
    await connect(three());
    expect(reconcileAllGroupsMock.mock.calls[0][1]).toEqual(['g-b', 'g-c']);

    // A completed sweep closes the open one: nothing is owed afterwards.
    expect(groupsAskedInOpenSweep('u-c', 'dev-c', 'store-tail').size).toBe(0);
  });

  it('a stopped pass is re-run when the app returns to the foreground', async () => {
    closeOpenSweep('u-c', 'dev-c');
    incarnationMock.mockResolvedValue('store-fg');
    (window as unknown as Record<string, unknown>).__canariForeground = false;
    reconcileAllGroupsMock.mockResolvedValueOnce({ asked: [], complete: false });
    await connect(creatingMls());
    reconcileAllGroupsMock.mockClear();
    reconcileAllGroupsMock.mockResolvedValue({ asked: ['g-old'], complete: true });

    (window as unknown as Record<string, unknown>).__canariForeground = true;
    window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: true } }));
    await vi.waitFor(() => expect(reconcileAllGroupsMock).toHaveBeenCalledTimes(1));
    delete (window as unknown as Record<string, unknown>).__canariForeground;
  });

  it('a store that cannot name its incarnation is read as a new one', async () => {
    noteConnection('u-c', 'dev-c', Date.now(), 'store-1');
    incarnationMock.mockRejectedValueOnce(new Error('store closed'));
    const log = await connect(creatingMls());
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cannot name its incarnation'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('sweeping every group'));
  });
});
