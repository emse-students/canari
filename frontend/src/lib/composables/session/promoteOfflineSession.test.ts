import { SessionExpiredError } from '$lib/stores/auth';
import { connectivity } from '$lib/stores/connectivity.svelte';

const getToken = vi.hoisted(() => vi.fn());
const initializeConnection = vi.hoisted(() => vi.fn());
const flushOutbox = vi.hoisted(() => vi.fn());
const applyOutboxPendingStatuses = vi.hoisted(() => vi.fn(async () => {}));
const startPushService = vi.hoisted(() => vi.fn(async () => {}));
const runGroupDiscoveryImpl = vi.hoisted(() => vi.fn());
const startConnectionWatchdogImpl = vi.hoisted(() => vi.fn());
const startSyncWatchdogImpl = vi.hoisted(() => vi.fn());

vi.mock('$lib/stores/auth', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/auth')>()),
  getToken,
}));
vi.mock('$lib/utils/chat/connection', () => ({
  initializeConnection,
  getIsTabLeader: () => true,
}));
vi.mock('$lib/utils/chat/outbox', () => ({ flushOutbox, applyOutboxPendingStatuses }));
vi.mock('$lib/services/PushNotificationService', () => ({ startPushService }));
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => true }));
vi.mock('./sessionConnection', () => ({ runGroupDiscoveryImpl, startConnectionWatchdogImpl }));
vi.mock('./sessionWatchdogs', () => ({ startSyncWatchdogImpl }));

const { promoteOfflineSession, registerOfflinePromotion, unregisterOfflinePromotion } =
  await import('./promoteOfflineSession');

/** Minimal SessionContext covering only what the promotion reads or writes. */
function makeCtx(over: { loggedIn?: boolean; offline?: boolean } = {}) {
  const state = {
    authToken: '',
    offlineSession: over.offline ?? true,
    loggedIn: over.loggedIn ?? true,
  };
  return {
    state,
    ctx: {
      isLoggedIn: () => state.loggedIn,
      isOfflineSession: () => state.offlineSession,
      setIsOfflineSession: (v: boolean) => {
        state.offlineSession = v;
      },
      setAuthToken: (v: string) => {
        state.authToken = v;
      },
      getHistoryBaseUrl: () => 'https://example.test',
      getMyDeviceId: () => 'device-1',
      ensureMls: () => ({}),
    } as any,
  };
}

function makeCb() {
  return {
    log: vi.fn(),
    onSessionExpired: vi.fn(),
  } as any;
}

const makeDeps = () => ({}) as any;

describe('promoteOfflineSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectivity.reset();
    unregisterOfflinePromotion();
    getToken.mockResolvedValue('fresh-token');
    initializeConnection.mockResolvedValue(undefined);
  });

  it('acquires a token, reconnects, and clears the offline flag', async () => {
    const { ctx, state } = makeCtx();
    const cb = makeCb();

    await promoteOfflineSession(ctx, cb, makeDeps);

    expect(state.authToken).toBe('fresh-token');
    expect(state.offlineSession).toBe(false);
    expect(initializeConnection).toHaveBeenCalledTimes(1);
    expect(flushOutbox).toHaveBeenCalledTimes(1);
    // Nothing here reconciles history: `initializeConnection` ends with a reconciliation pass over
    // every local group, so a promotion that re-opens the socket has already asked.
    expect(startPushService).toHaveBeenCalledWith(
      'https://example.test',
      'fresh-token',
      'device-1'
    );
  });

  it('flushes the outbox only AFTER the connection is open', async () => {
    const order: string[] = [];
    initializeConnection.mockImplementation(async () => {
      order.push('connect');
    });
    flushOutbox.mockImplementation(() => {
      order.push('flush');
    });
    const { ctx } = makeCtx();

    await promoteOfflineSession(ctx, makeCb(), makeDeps);

    // A flush before the socket is up sends into a session that cannot deliver, burning one
    // attempt and one backoff step per queued message.
    expect(order).toEqual(['connect', 'flush']);
  });

  it('starts the watchdogs only once a real token exists', async () => {
    const { ctx } = makeCtx();
    await promoteOfflineSession(ctx, makeCb(), makeDeps);

    expect(startConnectionWatchdogImpl).toHaveBeenCalledTimes(1);
    expect(startSyncWatchdogImpl).toHaveBeenCalledTimes(1);
    expect(runGroupDiscoveryImpl).toHaveBeenCalledTimes(1);
  });

  it('signs the user out when the server answers that the session is dead', async () => {
    getToken.mockRejectedValue(new SessionExpiredError());
    const { ctx, state } = makeCtx();
    const cb = makeCb();

    await promoteOfflineSession(ctx, cb, makeDeps);

    expect(cb.onSessionExpired).toHaveBeenCalledTimes(1);
    expect(state.authToken).toBe('');
    // Still offline: nothing was promoted, and no socket was opened for a dead session.
    expect(state.offlineSession).toBe(true);
    expect(initializeConnection).not.toHaveBeenCalled();
    expect(flushOutbox).not.toHaveBeenCalled();
  });

  it('stays offline, without signing out, when the network is still down', async () => {
    getToken.mockRejectedValue(new TypeError('fetch failed'));
    const { ctx, state } = makeCtx();
    const cb = makeCb();

    await promoteOfflineSession(ctx, cb, makeDeps);

    // A transport failure is not an answer about the session - logging the user out here would
    // sign them out for a dropped packet.
    expect(cb.onSessionExpired).not.toHaveBeenCalled();
    expect(state.offlineSession).toBe(true);
    expect(connectivity.isOffline).toBe(true);
    expect(initializeConnection).not.toHaveBeenCalled();
  });

  it('is a no-op on a session that already holds a token', async () => {
    const { ctx } = makeCtx({ offline: false });

    await promoteOfflineSession(ctx, makeCb(), makeDeps);

    expect(getToken).not.toHaveBeenCalled();
    expect(initializeConnection).not.toHaveBeenCalled();
  });

  it('is a no-op when nobody is logged in', async () => {
    const { ctx } = makeCtx({ loggedIn: false });

    await promoteOfflineSession(ctx, makeCb(), makeDeps);

    expect(getToken).not.toHaveBeenCalled();
  });

  it('coalesces concurrent promotions into a single run', async () => {
    let release: (v: string) => void = () => {};
    getToken.mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve;
      })
    );
    const { ctx } = makeCtx();
    const cb = makeCb();

    const a = promoteOfflineSession(ctx, cb, makeDeps);
    const b = promoteOfflineSession(ctx, cb, makeDeps);
    release('fresh-token');
    await Promise.all([a, b]);

    // A flapping link fires `online` repeatedly; each extra run would open its own WebSocket.
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(initializeConnection).toHaveBeenCalledTimes(1);
  });

  it('promotes when the connectivity store reports a reconnection', async () => {
    const { ctx, state } = makeCtx();
    registerOfflinePromotion(ctx, makeCb(), makeDeps);

    connectivity.notifyServerUnreachable();
    connectivity.notifyServerReachable();
    await vi.waitFor(() => expect(state.offlineSession).toBe(false));

    expect(initializeConnection).toHaveBeenCalledTimes(1);
  });

  it('does not promote a session that has been logged out', async () => {
    const { ctx } = makeCtx();
    registerOfflinePromotion(ctx, makeCb(), makeDeps);
    unregisterOfflinePromotion();

    connectivity.notifyServerUnreachable();
    connectivity.notifyServerReachable();

    expect(getToken).not.toHaveBeenCalled();
  });
});
