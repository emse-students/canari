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
const { createMlsHolder } = await import('./mlsHolder');
const { registerMlsStatePersister, unregisterMlsStatePersister, activeMlsStatePersister } =
  await import('$lib/mls-client/mlsStatePersisterRegistry');
import type { IMlsService } from '$lib/mls-client';
import type { MlsStatePersister } from '$lib/mls-client/mlsStatePersister';
const { endSessionImpl } = await import('./sessionAuth');
const { resumeConnectionImpl } = await import('./sessionConnection');

const fetchMock = vi.fn<() => Promise<Response>>();

/** The fields of the context the sign-out and the resume read, over a live session. */
function liveSession() {
  let loggedIn = true;
  // One fake client per account, through the REAL holder: what the sign-out does to the client
  // the next sign-in gets is the behaviour under test.
  const clients: { pauseSocket: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[] =
    [];
  // The one helper that ends the native MLS session (`endNativeMlsSession`), as the app wires it.
  const endNative = vi.fn(async (_reason: string) => {});
  const holder = createMlsHolder(() => {
    const client = { pauseSocket: vi.fn(), isWsOpen: vi.fn(() => false), destroy: vi.fn() };
    clients.push(client);
    return client as unknown as IMlsService;
  }, endNative);
  const mls = holder.ensure() as unknown as (typeof clients)[number];
  const ensureMls = vi.fn(() => holder.ensure());
  const ctx = {
    retireMls: (finalWrite: Promise<void>) => holder.retire(finalWrite),
    whenMlsRetired: () => holder.whenRetired(),
    isMlsRetiring: () => holder.isRetiring(),
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
    invalidateRestores: vi.fn(),
    forgetUnconfirmedSalonDraws: vi.fn(),
    setSelectedContact: vi.fn(),
  } as unknown as ChatSessionCallbacks;
  return { ctx, cb, mls, ensureMls, clearConversations, log, clients, endNative };
}

/** A persister whose final flush lands only when the test says so. */
function heldPersister() {
  let land: () => void = () => {};
  const flushEncrypted = vi.fn(() => new Promise<void>((resolve) => (land = resolve)));
  const persister = {
    persistNow: vi.fn(),
    scheduleDeferred: vi.fn(),
    flush: vi.fn(async () => {}),
    flushEncrypted,
    onBulkIngestStart: vi.fn(),
    onBulkIngestEnd: vi.fn(async () => {}),
  } as unknown as MlsStatePersister;
  return { persister, land: () => land() };
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
      // The restore chain ends with the session, or a queued restore would run as this account.
      expect(s.cb.invalidateRestores).toHaveBeenCalledTimes(1);
      expect(s.cb.forgetUnconfirmedSalonDraws).toHaveBeenCalledTimes(1);
      // The native MLS session (the process-wide manager and its key) ends with the account.
      await s.ctx.whenMlsRetired();
      expect(s.endNative).toHaveBeenCalledWith('sign-out');

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

/**
 * Account A signs out, account B signs in, in one process.
 *
 * Before 2026-10-14 the MLS client survived a sign-out: `BaseMlsService.init` returns at once on a
 * client that already ran and `resolveDeviceId` hands back its cached id, so B unlocked on A's
 * decrypted state and A's device id. The ghost session hid it (B never got as far as a login).
 */
describe('a sign-out retires the account with its MLS client', () => {
  afterEach(() => unregisterMlsStatePersister());

  it('hands the next sign-in a fresh client, and destroys the old one only after its final write', async () => {
    const s = liveSession();
    const a = heldPersister();
    registerMlsStatePersister(a.persister);
    setSignOutHandler(() => endSessionImpl(s.ctx, s.cb));
    try {
      // A signs out.
      await clearAuth();
      expect(a.persister.flushEncrypted).toHaveBeenCalledTimes(1);

      // B's login asks for a client while A's final checkpoint is still being written: a NEW one.
      expect(s.ctx.isMlsRetiring()).toBe(true);
      const forB = s.ctx.ensureMls();
      expect(forB).not.toBe(s.clients[0]);
      expect(s.clients[0].destroy).not.toHaveBeenCalled();

      // ...and a login waiting on the retirement is not released before that write lands.
      let released = false;
      void s.ctx.whenMlsRetired().then(() => (released = true));
      await Promise.resolve();
      expect(released).toBe(false);
      // A's native session is still needed by its final checkpoint, so it has not ended yet...
      expect(s.endNative).not.toHaveBeenCalled();

      a.land();
      await s.ctx.whenMlsRetired();
      expect(released).toBe(true);
      expect(s.clients[0].destroy).toHaveBeenCalledTimes(1);
      // ...and it has ended before B's login is released to open its own state.
      expect(s.endNative).toHaveBeenCalledTimes(1);
      expect(s.endNative).toHaveBeenCalledWith('sign-out');
      expect(s.ctx.isMlsRetiring()).toBe(false);
      expect(s.ctx.ensureMls()).toBe(forB);
    } finally {
      setSignOutHandler(null);
    }
  });

  it("leaves the NEXT session's persister registered when the old final write lands late", async () => {
    const s = liveSession();
    const a = heldPersister();
    registerMlsStatePersister(a.persister);
    setSignOutHandler(() => endSessionImpl(s.ctx, s.cb));
    try {
      await clearAuth();
      // B's session registers its persister before A's final flush has landed.
      const b = heldPersister();
      registerMlsStatePersister(b.persister);

      a.land();
      await s.ctx.whenMlsRetired();
      expect(activeMlsStatePersister()).toBe(b.persister);
    } finally {
      setSignOutHandler(null);
    }
  });
});
