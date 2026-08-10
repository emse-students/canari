/**
 * The pause/resume pair, and the reconnect circuit.
 *
 * These pin the shape of a defect measured on hardware 2026-08-10: a phone parked on /chat with the
 * "En attente de connexion" banner up for ~20 minutes, making ZERO reconnect attempts while HTTP
 * kept working, then reconnecting 330 ms after a network change. Two independent causes, both here:
 * `pauseConnection` disarms the watchdogs and nothing re-armed them, and the reconnect circuit
 * opened with nothing able to close it.
 */
const startSyncWatchdogImpl = vi.hoisted(() => vi.fn());
const openGatewayConnection = vi.hoisted(() => vi.fn());
const syncConnectionAfterWsOpen = vi.hoisted(() => vi.fn(async () => {}));
const discoverMissingGroups = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('./sessionWatchdogs', () => ({ startSyncWatchdogImpl }));
vi.mock('./sessionAuth', () => ({
  makeRecoveryDeps: vi.fn(() => ({})),
  processDeviceInvitationsLocally: vi.fn(),
}));
vi.mock('$lib/utils/chat/connection', () => ({
  openGatewayConnection,
  syncConnectionAfterWsOpen,
  getIsTabLeader: () => true,
}));
vi.mock('$lib/utils/chat/actions', () => ({ discoverMissingGroups }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({ appendLog: vi.fn() }));

const { pauseConnectionImpl, resumeConnectionImpl, scheduleReconnectImpl } =
  await import('./sessionConnection');
import type { SessionContext, ChatSessionCallbacks } from './sessionTypes';

/** Minimal SessionContext covering only what these three functions read or write. */
function makeCtx(over: { connected?: boolean } = {}) {
  const state = {
    loggedIn: true,
    wsConnected: over.connected ?? false,
    reconnecting: false,
    circuitOpen: false,
    attempts: 0,
  };
  const timers: Record<string, unknown> = {
    reconnect: null,
    health: null,
    syncWatchdog: null,
    connectionWatchdog: null,
  };
  return {
    state,
    timers,
    ctx: {
      isLoggedIn: () => state.loggedIn,
      isWsConnected: () => state.wsConnected,
      setIsWsConnected: (v: boolean) => {
        state.wsConnected = v;
      },
      isReconnecting: () => state.reconnecting,
      setIsReconnecting: (v: boolean) => {
        state.reconnecting = v;
      },
      isReconnectCircuitOpen: () => state.circuitOpen,
      setReconnectCircuitOpen: (v: boolean) => {
        state.circuitOpen = v;
      },
      getReconnectAttempts: () => state.attempts,
      setReconnectAttempts: (v: number) => {
        state.attempts = v;
      },
      timers,
      getStorage: () => undefined,
      ensureMls: () => ({ sendDisconnect: vi.fn(), isWsOpen: () => false }),
      RECONNECT_DELAYS: [1000, 2000, 4000],
      MAX_RECONNECT_ATTEMPTS: 3,
    } as unknown as SessionContext,
  };
}

const makeCb = () =>
  ({
    log: vi.fn(),
    conversations: new Map(),
    saveConversation: vi.fn(),
  }) as unknown as ChatSessionCallbacks;

describe('the pause/resume pair', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    openGatewayConnection.mockResolvedValue(true);
  });
  afterEach(() => vi.useRealTimers());

  it('re-arms the watchdogs that pausing stopped', async () => {
    const { ctx, timers } = makeCtx();
    const cb = makeCb();

    // Arm, then background: this is the transition that used to be one-way.
    startSyncWatchdogImpl.mockImplementation(() => {
      timers.syncWatchdog = 1;
    });
    startSyncWatchdogImpl(ctx, cb);
    timers.connectionWatchdog = 1;

    pauseConnectionImpl(ctx);
    expect(timers.connectionWatchdog).toBeNull();
    expect(timers.syncWatchdog).toBeNull();

    await resumeConnectionImpl(ctx, cb);
    expect(timers.connectionWatchdog).not.toBeNull();
    expect(startSyncWatchdogImpl).toHaveBeenCalledTimes(2);
  });

  it('re-arms even when the socket survived the background, since pausing disarmed it anyway', async () => {
    const { ctx, timers } = makeCtx({ connected: true });
    const cb = makeCb();

    pauseConnectionImpl(ctx);
    // pauseConnection clears the flag itself; the app may reconnect underneath before we resume.
    ctx.setIsWsConnected(true);

    await resumeConnectionImpl(ctx, cb);
    expect(timers.connectionWatchdog).not.toBeNull();
    expect(startSyncWatchdogImpl).toHaveBeenCalled();
    // Already connected - no reason to open a second socket.
    expect(openGatewayConnection).not.toHaveBeenCalled();
  });

  it('closes the reconnect circuit, which nothing else ever did', async () => {
    const { ctx, state, timers } = makeCtx();
    const cb = makeCb();

    // Burn the budget the way a real outage does, and confirm it latches shut.
    for (let i = 0; i <= 3; i++) {
      state.attempts = i;
      timers.reconnect = null;
      scheduleReconnectImpl(ctx, cb);
    }
    expect(state.circuitOpen).toBe(true);
    timers.reconnect = null;
    scheduleReconnectImpl(ctx, cb);
    expect(timers.reconnect).toBeNull(); // the watchdog reaches here too, and gets nothing

    await resumeConnectionImpl(ctx, cb);
    expect(state.circuitOpen).toBe(false);
    expect(state.attempts).toBe(0);

    // And the ladder works again, which is the whole point of closing it.
    state.wsConnected = false;
    timers.reconnect = null;
    scheduleReconnectImpl(ctx, cb);
    expect(timers.reconnect).not.toBeNull();
  });

  it('stays out of the way when logged out', async () => {
    const { ctx, state, timers } = makeCtx();
    state.loggedIn = false;
    await resumeConnectionImpl(ctx, makeCb());
    expect(timers.connectionWatchdog).toBeNull();
    expect(startSyncWatchdogImpl).not.toHaveBeenCalled();
  });
});
