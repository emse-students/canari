import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from './sessionTypes';
import type { ChatSessionCallbacks } from './sessionTypes';

/**
 * The Mi 9T failure of 2026-10-14, replayed at the composable level: sign out, come back to the
 * foreground (the resume that follows the sign-in browser), sign out again (the PIN gate's exit).
 *
 * `signOutEndsLiveSession.test.ts` pins the wiring in the source; this runs the real `clearAuth`,
 * the real `endSessionImpl` and the real `resumeConnectionImpl` over one stub context, so what is
 * asserted is the BEHAVIOUR the log showed: the resume must not touch the socket of a session that
 * was signed out, and a second sign-out must not run a second, flushing teardown.
 */

vi.mock('$lib/stores/user', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/user')>()),
  currentUserId: () => 'user-1',
  clearUserLocally: vi.fn(),
}));

const { clearAuth, setSignOutHandler } = await import('$lib/stores/auth');
const { endSessionImpl } = await import('./sessionAuth');
const { resumeConnectionImpl } = await import('./sessionConnection');

const fetchMock = vi.fn<() => Promise<Response>>();

/** The fields of the context the sign-out and the resume read, over a live session. */
function liveSession() {
  let loggedIn = true;
  const mls = { pauseSocket: vi.fn(), isWsOpen: vi.fn(() => false) };
  const ensureMls = vi.fn(() => mls);
  const ctx = {
    timers: { reconnect: null, health: null, syncWatchdog: null, connectionWatchdog: null },
    isLoggedIn: () => loggedIn,
    setIsLoggedIn: (v: boolean) => {
      loggedIn = v;
    },
    ensureMls,
    getUserId: () => 'user-1',
    getAuthToken: () => 'h.e.s',
    setAuthToken: vi.fn(),
    getMyDeviceId: () => 'device-1',
    getHistoryBaseUrl: () => 'http://history',
    setStorage: vi.fn(),
    setReconnectAttempts: vi.fn(),
    setTabLeaderSessionCb: vi.fn(),
    setIsWsConnected: vi.fn(),
    isWsConnected: () => false,
    setConnectionPaused: vi.fn(),
    setIsMessagingInitializing: vi.fn(),
    getCallService: () => null,
  } as unknown as SessionContext;
  const conversations = new Map<string, unknown>([['peer', {}]]);
  const clearConversations = vi.spyOn(conversations, 'clear');
  const log = vi.fn<(line: string) => void>();
  const cb = {
    log,
    conversations,
    setSelectedContact: vi.fn(),
  } as unknown as ChatSessionCallbacks;
  return { ctx, cb, mls, ensureMls, clearConversations, log };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

describe('sign-out, then the resume of the sign-in browser, then a second sign-out', () => {
  it('ends the session once, releases its socket, and leaves the resume nothing to reconnect', async () => {
    const s = liveSession();
    setSignOutHandler(() => endSessionImpl(s.ctx, s.cb));
    try {
      // 1. Tableau de bord > Deconnexion.
      await clearAuth();
      expect(s.ctx.isLoggedIn()).toBe(false);
      expect(s.mls.pauseSocket).toHaveBeenCalledTimes(1);
      expect(s.clearConversations).toHaveBeenCalledTimes(1);

      // 2. The app comes back from the sign-in browser before the callback has its token.
      s.ensureMls.mockClear();
      await resumeConnectionImpl(s.ctx, s.cb);
      // No socket asked for, no watchdog re-armed: there is no session to resume.
      expect(s.ensureMls).not.toHaveBeenCalled();
      expect(s.log.mock.calls.flat().join('\n')).not.toContain('App in foreground');

      // 3. A second sign-out (the PIN gate's) finds nothing live: no second, flushing teardown.
      await clearAuth();
      expect(s.mls.pauseSocket).toHaveBeenCalledTimes(1);
      expect(s.clearConversations).toHaveBeenCalledTimes(1);
      expect(s.log).toHaveBeenCalledWith(
        '[LOGOUT] Signed out with no live session on this device - nothing to stop.'
      );
    } finally {
      setSignOutHandler(null);
    }
  });
});
