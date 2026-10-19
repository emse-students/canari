/**
 * A reconnect stopped by a sign-out is not a dead session.
 *
 * `SignOutInProgressError` is what a refresh throws while the user is signing out (`auth.ts`). The
 * reconnect used to see only `SessionExpiredError` there, and answered it with `setIsLoggedIn(false)`
 * and its own `goto('/login')` - a navigation racing the sign-out's, for a verdict nobody reached.
 * It must stop: no redirect, no logged-in flag of its own, no backoff rung armed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignOutInProgressError } from '$lib/stores/auth';

const goto = vi.hoisted(() => vi.fn());
const openGatewayConnection = vi.hoisted(() => vi.fn());

vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/utils/chat/connection', () => ({
  openGatewayConnection,
  syncConnectionAfterWsOpen: vi.fn(),
  getIsTabLeader: () => true,
}));
vi.mock('$lib/utils/chat/recovery', () => ({
  requestReAdd: vi.fn(),
  recoverRosterDisagreement: vi.fn(),
  RECOVERY_TIMEOUT_MS: 60_000,
}));
vi.mock('./sessionAuth', () => ({
  makeRecoveryDeps: vi.fn(),
  processDeviceInvitationsLocally: vi.fn(),
}));

const { attemptReconnectImpl } = await import('./sessionConnection');

describe('a reconnect while the user is signing out', () => {
  beforeEach(() => {
    goto.mockReset();
    openGatewayConnection.mockReset();
  });

  it('stops: no redirect, no logout of its own, no retry armed', async () => {
    openGatewayConnection.mockRejectedValue(new SignOutInProgressError('request'));
    const setIsLoggedIn = vi.fn();
    const ctx = {
      timers: { reconnect: null as ReturnType<typeof setTimeout> | null },
      isLoggedIn: () => true,
      isReconnecting: () => false,
      setIsReconnecting: vi.fn(),
      setIsLoggedIn,
      ensureMls: () => ({}),
      getUserId: () => 'u1',
      getDeviceKey: () => 'k',
      setIsWsConnected: vi.fn(),
      setReconnectAttempts: vi.fn(),
      getReconnectAttempts: () => 0,
      isConnectionPaused: () => false,
      RECONNECT_DELAYS: [1000],
    } as never;
    const cb = { log: vi.fn(), conversations: new Map() } as never;

    await attemptReconnectImpl(ctx, cb);

    expect(goto).not.toHaveBeenCalled();
    expect(setIsLoggedIn).not.toHaveBeenCalled();
    expect((ctx as { timers: { reconnect: unknown } }).timers.reconnect).toBeNull();
  });
});
