/**
 * The pause/resume pair, and the reconnect ladder that must never end.
 *
 * These pin the shape of two defects. On hardware 2026-08-10: a phone parked on /chat with the
 * "En attente de connexion" banner up for ~20 minutes, making ZERO reconnect attempts while HTTP
 * kept working, then reconnecting 330 ms after a network change - `pauseConnection` disarmed the
 * watchdogs and nothing re-armed them.
 *
 * On production tabs 2026-08-14 (WP-RECONNECT-1): the same silence, from the other cause. The
 * ladder stopped after 20 attempts and latched a circuit whose only two release events - foreground
 * and `online` - a visible desktop tab on an unchanged network cannot emit. Measured: seven-hour-old
 * pages, the watchdog firing every 60 s, zero attempts, zero sockets. So the test below is now the
 * MIRROR of the one it replaces: the ladder is asserted to keep climbing past any count.
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
      getReconnectAttempts: () => state.attempts,
      setReconnectAttempts: (v: number) => {
        state.attempts = v;
      },
      timers,
      getStorage: () => undefined,
      // THE FIXTURE HAS TO BE COMPLETE ENOUGH FOR attemptReconnect TO REACH THE GATEWAY CALL.
      // Without these, it threw a TypeError on `ctx.getUserId()`, the catch classified it as a
      // transport failure and scheduled a rung - so every test here measured a ladder driven by its
      // own fixture's incompleteness rather than by the connection outcome it was mocking.
      getUserId: () => 'someone',
      getDeviceKey: () => 'device-key',
      connectionRecoveryTimers: new Map(),
      ensureMls: () => ({ sendDisconnect: vi.fn(), isWsOpen: () => false }),
      RECONNECT_DELAYS: [1000, 2000, 4000],
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

  it('climbs for ever on its own, with no lifecycle event and no watchdog', async () => {
    const { ctx, state, timers } = makeCtx();
    const cb = makeCb();
    openGatewayConnection.mockResolvedValue(false);

    // ONE push, then the real clock. Nothing in this test emits `online`, a foreground transition,
    // or a watchdog tick - so every rung after the first was armed by the ladder itself. That is the
    // half that never worked: both in-function reschedules ran while `isReconnecting` was still
    // true and were dropped in silence, which is why the 60 s watchdog was the true retry driver.
    scheduleReconnectImpl(ctx, cb);
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(30_000);

    // Far past the 20 attempts at which the circuit used to latch shut for ever.
    expect(state.attempts).toBeGreaterThan(20);
    expect(openGatewayConnection.mock.calls.length).toBeGreaterThan(20);
    expect(timers.reconnect).not.toBeNull();

    // Unbounded in COUNT must still be bounded in RATE, and exactly one rung may be armed at a
    // time: a ladder that leaked a timer per attempt would turn "never gives up" into a storm.
    expect(vi.getTimerCount()).toBe(1);
  });

  it('resets the ladder to its first rung on resume, and clears the rung already armed', async () => {
    const { ctx, state, timers } = makeCtx();
    const cb = makeCb();

    // A client deep in the backoff, waiting out its 30 s cap.
    state.attempts = 42;
    scheduleReconnectImpl(ctx, cb);
    expect(timers.reconnect).not.toBeNull();

    await resumeConnectionImpl(ctx, cb);
    // Back to the first rung, so real evidence that the outage ended is acted on now rather than
    // up to 30 s later - which is all these two events buy, now that recovery no longer needs them.
    expect(state.attempts).toBe(0);
    // And the armed rung is CLEARED rather than orphaned: merely dropping the reference left it
    // running, and it later orphaned the rung scheduled in the meantime - two ladders in parallel.
    expect(timers.reconnect).toBeNull();
  });

  it('stays out of the way when logged out', async () => {
    const { ctx, state, timers } = makeCtx();
    state.loggedIn = false;
    await resumeConnectionImpl(ctx, makeCb());
    expect(timers.connectionWatchdog).toBeNull();
    expect(startSyncWatchdogImpl).not.toHaveBeenCalled();
  });
});
