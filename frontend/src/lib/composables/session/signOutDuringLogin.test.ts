// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import type { IMlsService } from '$lib/mls-client';
import type { IStorage } from '$lib/db';
import type { ChatSessionCallbacks, SessionContext } from './sessionTypes';

/**
 * A SIGN-OUT DURING A LOGIN IN PROGRESS STOPS THAT LOGIN - run over the real `loginImpl`, the real
 * `clearAuth` and the real `endSessionImpl` wired as the app shell wires it (`setSignOutHandler`).
 *
 * Before the fix, a sign-out in the ~12 s native decrypt of a Mi 9T found no live session
 * (`isLoggedIn` still false), so `endSessionImpl` stopped nothing, and the login completed afterwards:
 * `isLoggedIn` true for a signed-out user, its gateway socket open. Stand-ins: the platform client
 * (whose `init` and `connect` the test resolves by hand - deferred promises, no clock), the token,
 * the stores and the tab lock.
 */

vi.mock('$lib/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/auth')>()),
  getToken: vi.fn(async () => 'access-token'),
}));

const storage = { close: vi.fn(async () => {}) } as unknown as IStorage;
vi.mock('$lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/db')>()),
  getStorage: vi.fn(async () => storage),
}));

vi.mock('$lib/utils/hex', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/hex')>()),
  loadMlsState: vi.fn(async () => undefined),
  mlsStateSize: vi.fn(async () => 0),
}));

/** Resolves the step the test is holding; `reached` settles once the login is waiting on it. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
let gatewayHeld: ReturnType<typeof deferred<boolean>> | null = null;
let gatewayReached = deferred();
const syncConnectionAfterWsOpen = vi.fn(async () => undefined);
vi.mock('$lib/utils/chat/connection', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/utils/chat/connection')>();
  return {
    ...real,
    initTabLeadershipAsync: vi.fn(async () => true),
    getIsTabLeader: () => true,
    // What the real one does on a leader tab, minus the token import: the socket opens beside the load.
    startGatewayHandshake: (deps: { mlsService: IMlsService }) =>
      deps.mlsService.connect('access-token').then(
        () => null,
        (e: unknown) => e as Error
      ),
    openGatewayConnection: vi.fn(async () => {
      gatewayReached.resolve();
      return gatewayHeld ? gatewayHeld.promise : true;
    }),
    syncConnectionAfterWsOpen,
    setupMessageHandler: vi.fn(),
  };
});

const { clearAuth, setSignOutHandler } = await import('$lib/stores/auth');
const { loginImpl, endSessionImpl } = await import('./sessionAuth');
const { createMlsHolder } = await import('./mlsHolder');

/** The platform client: `init` held by the test, a socket that is open between connect and pause. */
function fakeClient(initHeld: { promise: Promise<void> } | null) {
  const initReached = deferred();
  const state = { socketOpen: false };
  const known = {
    init: vi.fn(async () => {
      initReached.resolve();
      if (initHeld) await initHeld.promise;
    }),
    connect: vi.fn(async () => {
      state.socketOpen = true;
    }),
    pauseSocket: vi.fn(() => {
      state.socketOpen = false;
    }),
    destroy: vi.fn(),
    resolveDeviceId: vi.fn(async () => 'device-1'),
    isDeviceRevoked: vi.fn(async () => false),
    getDeviceId: () => 'device-1',
    getLocalGroups: () => [],
    hydrateDistributionGroups: vi.fn(async () => {}),
    markInboundReady: vi.fn(async () => {}),
  };
  // Every other method is a no-op: the login registers a dozen handlers on the client.
  const client = new Proxy(known as Record<string | symbol, unknown>, {
    get: (target, key) => (key in target ? target[key] : (target[key] = vi.fn())),
  }) as unknown as IMlsService;
  return { client, known, state, initReached };
}

/** A session context over a real MLS holder, recording every `isLoggedIn` it is given. */
function session(client: IMlsService) {
  let loggedIn = false;
  let inProgress = false;
  let userId = 'alice';
  let held: IStorage | null = null;
  const holder = createMlsHolder(() => client);
  const known: Partial<SessionContext> = {
    getUserId: () => userId,
    setUserId: (v) => (userId = v),
    getPin: () => '',
    // A vault login: the key came from the vault, so no PIN check.
    getDeviceKey: () => btoa('k'.repeat(32)),
    isLoggedIn: () => loggedIn,
    setIsLoggedIn: vi.fn((v: boolean) => (loggedIn = v)),
    isReconnecting: () => false,
    getIsLoginInProgress: () => inProgress,
    setIsLoginInProgress: (v) => (inProgress = v),
    isWipingRevokedDevice: () => false,
    isMlsRetiring: () => holder.isRetiring(),
    whenMlsRetired: () => holder.whenRetired(),
    ensureMls: () => holder.ensure(),
    resetMls: (only) => holder.reset(only),
    retireMls: (w) => holder.retire(w),
    getStorage: () => held,
    setStorage: (v) => (held = v),
    getHistoryBaseUrl: () => '',
    getAuthToken: () => '',
    getMyDeviceId: () => 'device-1',
    timers: { reconnect: null, health: null, syncWatchdog: null, connectionWatchdog: null },
  };
  const ctx = new Proxy(known as Record<string | symbol, unknown>, {
    get: (target, key) => (key in target ? target[key] : (target[key] = vi.fn())),
  }) as unknown as SessionContext;
  const cb = {
    log: vi.fn(),
    conversations: new Map(),
    setSelectedContact: vi.fn(),
    beginConversationSource: vi.fn(),
    endConversationSource: vi.fn(),
    loadAndRestoreConversations: vi.fn(async () => {}),
    saveConversation: vi.fn(async () => {}),
    onLoginFailed: vi.fn(),
    onSessionExpired: vi.fn(),
  } as unknown as ChatSessionCallbacks;
  // As the app shell wires it: every sign-out reaches the session.
  setSignOutHandler(() => endSessionImpl(ctx, cb));
  return { ctx, cb, holder, wentLive: () => known.setIsLoggedIn as ReturnType<typeof vi.fn> };
}

const logs = (cb: ChatSessionCallbacks) =>
  (cb.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 200 }))
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  gatewayHeld = null;
  gatewayReached = deferred();
  syncConnectionAfterWsOpen.mockClear();
});

afterEach(() => {
  setSignOutHandler(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a sign-out during a login in progress', () => {
  it('stops it: no isLoggedIn, no socket left open, its client destroyed, no second sign-out', async () => {
    const initHeld = deferred();
    const { client, known, state, initReached } = fakeClient(initHeld);
    const { ctx, cb, wentLive } = session(client);

    const login = loginImpl(ctx, cb);
    await initReached.promise;
    // The handshake started beside the state load, as on a device.
    expect(state.socketOpen).toBe(true);

    // The user signs out during the decrypt; the session is not live, so nothing is stopped yet.
    await clearAuth();
    expect(logs(cb)).toContain('nothing to stop');

    initHeld.resolve();
    await login;

    expect(wentLive()).not.toHaveBeenCalledWith(true);
    expect(ctx.isLoggedIn()).toBe(false);
    expect(state.socketOpen, 'the stopped login left its gateway socket open').toBe(false);
    expect(known.destroy).toHaveBeenCalledTimes(1);
    expect(ctx.getIsLoginInProgress()).toBe(false);
    expect(cb.onSessionExpired).not.toHaveBeenCalled();
    expect(cb.onLoginFailed).not.toHaveBeenCalled();
    expect(logs(cb)).toContain('after mls-init-and-storage');
  });

  it('after the session went live: the sign-out ends it and the login opens nothing further', async () => {
    gatewayHeld = deferred<boolean>();
    const { client, known, state } = fakeClient(null);
    const { ctx, cb, holder } = session(client);

    const login = loginImpl(ctx, cb);
    await gatewayReached.promise;
    expect(ctx.isLoggedIn()).toBe(true);

    // The sign-out finds a live session and ends it: socket paused, client retired.
    await clearAuth();
    expect(ctx.isLoggedIn()).toBe(false);
    expect(known.pauseSocket).toHaveBeenCalled();

    // The gateway answers late, its socket open again on the retired client.
    state.socketOpen = true;
    gatewayHeld.resolve(true);
    await login;
    await holder.whenRetired();

    expect(ctx.isLoggedIn()).toBe(false);
    expect(state.socketOpen, 'the stopped login left its gateway socket open').toBe(false);
    expect(syncConnectionAfterWsOpen).not.toHaveBeenCalled();
    expect(ctx.getIsLoginInProgress()).toBe(false);
    expect(cb.onSessionExpired).not.toHaveBeenCalled();
    expect(logs(cb)).toContain('after open-gateway');
  });
});
