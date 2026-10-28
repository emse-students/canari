// @vitest-environment happy-dom
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
 * (whose steps the test resolves by hand - deferred promises, no clock), the token, the stores, the
 * PIN derivations and the tab lock.
 */

vi.mock('$lib/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/auth')>()),
  getToken: vi.fn(async () => 'access-token'),
}));

// Every store call answers empty: the login's restore and outbox passes read it.
const storage = new Proxy({} as Record<string | symbol, unknown>, {
  get: (target, key) => (key === 'then' ? undefined : (target[key] ??= vi.fn(async () => []))),
}) as unknown as IStorage;
vi.mock('$lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/db')>()),
  getStorage: vi.fn(async () => storage),
}));

vi.mock('$lib/utils/hex', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/hex')>()),
  loadMlsState: vi.fn(async () => undefined),
  mlsStateSize: vi.fn(async () => 0),
  removeMlsState: vi.fn(async () => {}),
}));

/** The factory reset at the end of a revocation wipe - made to fail by one case. */
const wipeDeviceToFactory = vi.fn(async (): Promise<string[]> => []);
vi.mock('$lib/utils/deviceReset', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/deviceReset')>()),
  wipeDeviceToFactory: () => wipeDeviceToFactory(),
}));

// The PIN path's two PBKDF2 runs: the outcome under test is the server's answer, not the derivation.
vi.mock('$lib/utils/chat/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/auth')>()),
  computePinVerifier: vi.fn(async () => 'verifier'),
}));
vi.mock('$lib/crypto/deviceKey', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/crypto/deviceKey')>()),
  deriveDeviceKeyB64: vi.fn(async () => btoa('p'.repeat(32))),
}));

/** What forgets the "Rester connecte" slot - a sign-out keeps it. */
const clearDeviceKey = vi.fn();
vi.mock('$lib/utils/deviceKeyVault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/deviceKeyVault')>()),
  clearDeviceKey: (...args: unknown[]) => clearDeviceKey(...args),
  saveDeviceKey: vi.fn(async () => {}),
}));

/** A step the test holds; `resolve` lets it go. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
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
      deps.mlsService.connect('access-token', deps.mlsService.socketFence()).then(
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
const { loginImpl, endSessionImpl, recoverPinImpl } = await import('./sessionAuth');
const { loadMlsState } = await import('$lib/utils/hex');
const { LoginStoppedBySignOutError } = await import('./loginErrors');
const { createMlsHolder } = await import('./mlsHolder');

type Held = { promise: Promise<void> } | null;

/** The platform client: steps the test may hold, a socket open between connect and pause. */
function fakeClient(held: { init?: Held; resolveDeviceId?: Held } = {}) {
  const initReached = deferred();
  const resolveReached = deferred();
  const state = { socketOpen: false };
  const known = {
    init: vi.fn(async () => {
      initReached.resolve();
      if (held.init) await held.init.promise;
    }),
    connect: vi.fn(async () => {
      state.socketOpen = true;
    }),
    gatewaySocketSettled: vi.fn(async () => {}),
    socketFence: () => 0,
    pauseSocket: vi.fn(() => {
      state.socketOpen = false;
    }),
    destroy: vi.fn(),
    resolveDeviceId: vi.fn(async () => {
      resolveReached.resolve();
      if (held.resolveDeviceId) await held.resolveDeviceId.promise;
      return 'device-1';
    }),
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
  return { client, known, state, initReached, resolveReached };
}

/**
 * A session context over a real MLS holder that builds `clients` in order, recording every
 * `isLoggedIn` it is given. `pin` empty means a vault login; set, the PIN path.
 */
function session(clients: IMlsService[], pin = '') {
  let loggedIn = false;
  let inProgress = false;
  let userId = 'alice';
  let held: IStorage | null = null;
  let built = 0;
  // The one helper that ends the native MLS session (`endNativeMlsSession`), as the app wires it.
  const endNative = vi.fn(async (_reason: string) => {});
  const holder = createMlsHolder(() => clients[built++], endNative);
  const known: Partial<SessionContext> = {
    getUserId: () => userId,
    setUserId: (v) => (userId = v),
    getPin: () => pin,
    setPin: (v) => (pin = v),
    getDeviceKey: () => (pin ? '' : btoa('k'.repeat(32))),
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
    setLoginError: vi.fn(),
    timers: { reconnect: null, health: null, syncWatchdog: null, connectionWatchdog: null },
  };
  const ctx = new Proxy(known as Record<string | symbol, unknown>, {
    get: (target, key) => (key in target ? target[key] : (target[key] = vi.fn())),
  }) as unknown as SessionContext;
  const restore = deferred();
  const cb = {
    log: vi.fn(),
    conversations: new Map(),
    invalidateRestores: vi.fn(),
    forgetUnconfirmedSalonDraws: vi.fn(),
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
  return {
    ctx,
    cb,
    holder,
    endNative,
    restore,
    wentLive: () => known.setIsLoggedIn as ReturnType<typeof vi.fn>,
    shownErrors: () =>
      (known.setLoginError as ReturnType<typeof vi.fn>).mock.calls.filter(([msg]) => msg !== ''),
  };
}

const logs = (cb: ChatSessionCallbacks) =>
  (cb.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');

/**
 * The server: `pin-salt` answers, `pin-check` answers 401 (the session the sign-out revoked) - or,
 * with `pinCheckHangs`, never answers and rejects only when its request is aborted.
 */
let pinCheckHangs = false;
/** `pin-check` answers that this device was revoked. */
let pinCheckRevoked = false;
let pinCheckReached = deferred();
function server() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('pin-salt')) return Response.json({ salt: 'salt' });
      if (u.includes('pin-check') && pinCheckHangs) {
        pinCheckReached.resolve();
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        );
      }
      if (u.includes('pin-check') && pinCheckRevoked) {
        return Response.json({ status: 'ok', resetRequired: true });
      }
      if (u.includes('pin-check')) return new Response('', { status: 401 });
      return new Response('', { status: 200 });
    })
  );
}

beforeEach(() => {
  pinCheckHangs = false;
  pinCheckRevoked = false;
  pinCheckReached = deferred();
  server();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  gatewayHeld = null;
  gatewayReached = deferred();
  syncConnectionAfterWsOpen.mockClear();
  clearDeviceKey.mockClear();
  wipeDeviceToFactory.mockClear();
});

afterEach(() => {
  setSignOutHandler(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Nothing a failed login does: no callback, no error shown, the vault slot kept. */
function expectQuietStop(s: ReturnType<typeof session>) {
  expect(s.cb.onSessionExpired).not.toHaveBeenCalled();
  expect(s.cb.onLoginFailed).not.toHaveBeenCalled();
  expect(s.shownErrors()).toEqual([]);
  expect(clearDeviceKey, 'the sign-out keeps the "Rester connecte" slot').not.toHaveBeenCalled();
  expect(logs(s.cb)).toContain('[INIT] Login stopped - the account signed out during it');
}

describe('a sign-out during a login in progress', () => {
  it('stops it: no isLoggedIn, no socket left open, its client destroyed, no second sign-out', async () => {
    const initHeld = deferred();
    const a = fakeClient({ init: initHeld });
    const s = session([a.client]);

    const login = loginImpl(s.ctx, s.cb);
    await a.initReached.promise;
    // The handshake started beside the state load, as on a device.
    expect(a.state.socketOpen).toBe(true);

    // The user signs out during the decrypt.
    await clearAuth();

    initHeld.resolve();
    await login;
    await s.holder.whenRetired();

    expect(s.wentLive()).not.toHaveBeenCalledWith(true);
    expect(s.ctx.isLoggedIn()).toBe(false);
    expect(a.state.socketOpen, 'the stopped login left its gateway socket open').toBe(false);
    expect(a.known.destroy).toHaveBeenCalledTimes(1);
    // The stopped login's native MLS session ends too, before the next sign-in is released.
    expect(s.endNative).toHaveBeenCalled();
    expect(s.ctx.getIsLoginInProgress()).toBe(false);
    expectQuietStop(s);
    expect(logs(s.cb)).toContain('after mls-init-and-storage');
  });

  it('releases the socket again once a reopen queued by a rotation during init has settled', async () => {
    // The init rotated the device id and queued a reopen; the sign-out lands while it is in flight.
    // Released at the handshake alone, the socket that reopen opens would outlive the login.
    const initHeld = deferred();
    const a = fakeClient({ init: initHeld });
    const reopen = deferred();
    a.known.gatewaySocketSettled.mockImplementation(() => reopen.promise);
    const s = session([a.client]);

    const login = loginImpl(s.ctx, s.cb);
    await a.initReached.promise;
    await clearAuth();
    initHeld.resolve();
    await login;
    await s.holder.whenRetired();
    expect(a.state.socketOpen).toBe(false);

    // The reopen lands after the release, its socket open on the stopped login's client...
    a.state.socketOpen = true;
    const pausesBefore = a.known.pauseSocket.mock.calls.length;
    reopen.resolve();
    await new Promise((r) => setTimeout(r, 0));

    // ...and is released by the wait on the settle, not left open.
    expect(a.known.pauseSocket.mock.calls.length).toBeGreaterThan(pausesBefore);
    expect(a.state.socketOpen, 'a reopen outlived the stopped login').toBe(false);
  });

  it('after the session went live: the sign-out ends it and the login opens nothing further', async () => {
    gatewayHeld = deferred<boolean>();
    const a = fakeClient();
    const s = session([a.client]);

    const login = loginImpl(s.ctx, s.cb);
    await gatewayReached.promise;
    expect(s.ctx.isLoggedIn()).toBe(true);

    // The sign-out finds a live session and ends it: socket paused, client retired.
    await clearAuth();
    expect(s.ctx.isLoggedIn()).toBe(false);
    expect(a.known.pauseSocket).toHaveBeenCalled();

    // The gateway answers late, its socket open again on the retired client.
    a.state.socketOpen = true;
    gatewayHeld.resolve(true);
    await login;
    await s.holder.whenRetired();

    expect(s.ctx.isLoggedIn()).toBe(false);
    expect(a.state.socketOpen, 'the stopped login left its gateway socket open').toBe(false);
    expect(syncConnectionAfterWsOpen).not.toHaveBeenCalled();
    expect(s.ctx.getIsLoginInProgress()).toBe(false);
    expectQuietStop(s);
    expect(logs(s.cb)).toContain('after open-gateway');
  });

  it('an await that REJECTS after the sign-out is the sign-out, not a failed login', async () => {
    const a = fakeClient();
    const s = session([a.client]);
    const restoreHeld = deferred();
    const restoreReached = deferred();
    (s.cb.loadAndRestoreConversations as ReturnType<typeof vi.fn>).mockImplementation(() => {
      restoreReached.resolve();
      return restoreHeld.promise;
    });

    const login = loginImpl(s.ctx, s.cb);
    await restoreReached.promise;
    await clearAuth();
    // The teardown closed the store the restore was reading.
    restoreHeld.reject(new TypeError("Cannot read properties of null (reading 'getAll')"));
    await login;

    expect(s.ctx.isLoggedIn()).toBe(false);
    expectQuietStop(s);
    expect(logs(s.cb)).toContain('TypeError thrown after the sign-out');
  });

  it('the PIN check meeting the session the sign-out revoked (401) shows no PIN error', async () => {
    const resolveHeld = deferred();
    const a = fakeClient({ resolveDeviceId: resolveHeld });
    const s = session([a.client], '1234');

    const login = loginImpl(s.ctx, s.cb);
    await a.resolveReached.promise;
    await clearAuth();
    // pin-check now meets the revoked session and answers 401.
    resolveHeld.resolve();
    await login;

    expect(s.wentLive()).not.toHaveBeenCalledWith(true);
    expectQuietStop(s);
  });

  it('a sign-in started beside the stopped login gets its own client, and keeps its flag and socket', async () => {
    const aInit = deferred();
    const bInit = deferred();
    const a = fakeClient({ init: aInit });
    const b = fakeClient({ init: bInit });
    const s = session([a.client, b.client]);

    const loginA = loginImpl(s.ctx, s.cb);
    await a.initReached.promise;
    await clearAuth();

    // The PIN gate clears the flag to start a sign-in while A still decrypts (`handlePinSubmit`).
    s.ctx.setIsLoginInProgress(false);
    const loginB = loginImpl(s.ctx, s.cb);
    // B waits for A's client to be released before it touches MLS.
    expect(b.known.init).not.toHaveBeenCalled();

    aInit.resolve();
    await loginA;
    await b.initReached.promise;

    expect(a.known.destroy).toHaveBeenCalledTimes(1);
    expect(b.known.destroy, "A's release destroyed B's client").not.toHaveBeenCalled();
    expect(b.state.socketOpen, "A's release closed B's socket").toBe(true);
    expect(s.ctx.getIsLoginInProgress(), "A's exit released B's flag").toBe(true);

    bInit.resolve();
    await loginB;
    expect(s.ctx.isLoggedIn()).toBe(true);
    expect(s.ctx.ensureMls()).toBe(b.client);
  });
  it('a request that never answers does not hold the next sign-in: the sign-out cancels it', async () => {
    pinCheckHangs = true;
    const a = fakeClient();
    const b = fakeClient();
    const s = session([a.client, b.client], '1234');

    const loginA = loginImpl(s.ctx, s.cb);
    await pinCheckReached.promise;
    // The user signs out while pin-check hangs; A ends because its request is cancelled.
    await clearAuth();
    await loginA;
    expect(logs(s.cb)).toContain('after pin-check (cancelled)');

    // The next sign-in (the vault this time) is not held behind the hung request.
    s.ctx.setPin('');
    await loginImpl(s.ctx, s.cb);
    expect(b.known.init).toHaveBeenCalled();
    expect(s.ctx.isLoggedIn()).toBe(true);
    expect(s.wentLive()).toHaveBeenCalledTimes(1);
    expectQuietStop(s);
  });
  it('a login that FAILS after it went live leaves no session flag and no armed reconnect behind', async () => {
    // The login's handshake reopen failed and armed the ladder (`openGatewayConnection`); then a
    // later step of the same login threw. Left armed over `isLoggedIn` true, the rung would build a
    // fresh, uninitialised client from the holder and connect it.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = fakeClient();
    const s = session([a.client]);
    const rung = vi.fn();
    (s.cb.loadAndRestoreConversations as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // Zero delay: cleared, it never runs; left armed, the flush below runs it.
      s.ctx.timers.reconnect = setTimeout(rung, 0) as unknown as typeof s.ctx.timers.reconnect;
      throw new Error('restore failed');
    });

    await loginImpl(s.ctx, s.cb);

    expect(s.wentLive()).toHaveBeenCalledWith(true);
    expect(s.cb.onLoginFailed).toHaveBeenCalled();
    expect(s.ctx.isLoggedIn(), 'a failed login left the session flag up').toBe(false);
    expect(s.ctx.timers.reconnect, 'a failed login left a reconnect rung armed').toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(rung, 'the rung armed by the failed login still ran').not.toHaveBeenCalled();
    // Nor a native MLS session: the failed login's manager and key do not wait for the next one.
    expect(s.endNative).toHaveBeenCalledWith('client reset');
  });
  it('a revocation wipe that fails after its own sign-out is accused, not filed as a stopped login', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    wipeDeviceToFactory.mockRejectedValueOnce(new Error('IndexedDB delete blocked'));
    const a = fakeClient();
    a.known.isDeviceRevoked.mockResolvedValue(true);
    const s = session([a.client]);

    await loginImpl(s.ctx, s.cb);

    expect(s.ctx.isLoggedIn()).toBe(false);
    expect(logs(s.cb)).toContain('[SECURITY] The revoked-device wipe FAILED');
    expect(errors.mock.calls.flat().join(' ')).toContain('revoked-device wipe failed');
  });
  it('a revoked device on the PIN path ends as device_revoked: its own wipe does not cancel it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    pinCheckRevoked = true;
    const a = fakeClient();
    const s = session([a.client], '1234');

    await loginImpl(s.ctx, s.cb);

    expect(wipeDeviceToFactory).toHaveBeenCalled();
    expect(s.cb.onLoginFailed).toHaveBeenCalledWith(expect.any(String), 'device_revoked');
    expect(logs(s.cb)).not.toContain('[INIT] Login stopped');
    expect(logs(s.cb)).not.toContain('wipe FAILED');
    expect(errors.mock.calls.flat().join(' ')).not.toContain('wipe failed');
  });
});

/**
 * A SIGN-OUT DURING THE PIN GATE'S RECOVERY STOPS IT. The recovery opens the state and installs a
 * native manager while no session is live, and it was not tracked as a flow in flight: a sign-out
 * found "nothing to stop", the native session ended at once, and the recovery then went on to open
 * the state - installing a manager nothing would end.
 */
describe('a sign-out during the PIN recovery', () => {
  it('stops it before it touches the state, and retires on its end', async () => {
    pinCheckHangs = true;
    vi.mocked(loadMlsState).mockResolvedValueOnce(new Uint8Array([1]));
    const a = fakeClient();
    const s = session([a.client]);

    const recovery = recoverPinImpl(s.ctx, s.cb, '1111', '2222').then(
      () => null,
      (e: unknown) => e
    );
    await pinCheckReached.promise;

    // The gate's exit, during the new PIN's check.
    await clearAuth();
    const stopped = await recovery;
    await s.holder.whenRetired();

    expect(stopped).toBeInstanceOf(LoginStoppedBySignOutError);
    // No client was built for the stopped recovery, so nothing opened the state.
    expect(a.known.init).not.toHaveBeenCalled();
    expect(Object.keys(a.known)).not.toContain('openLocalStateWithKey');
    expect(logs(s.cb)).toContain('[LOGOUT] Signed out during a login');
    expect(logs(s.cb)).toContain('[PIN_RECOVER] Stopped by a sign-out before the new PIN check');
    expect(s.endNative).toHaveBeenCalledWith('sign-out');
  });
});
