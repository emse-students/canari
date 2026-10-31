// @vitest-environment happy-dom
// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import type { IStorage } from '$lib/db';
import type { ChatSessionCallbacks, SessionContext } from './sessionTypes';

/**
 * A DEVICE ITS OWNER REVOKED ENDS IN ONE RESET, WHATEVER TELLS IT FIRST (DEV-2 / DEV-3, 2026-10-25).
 *
 * The revocation ends the device's session server-side. Measured on the rig: the `device_revoked`
 * frame arrived, the frame's own check met the dead session (401, renewal refused), read it as
 * "unreachable - NOT revoked", logged "the server disagrees", and the device left only through the
 * generic expiry sign-out - which keeps every local store. Offline during the revocation (DEV-3), it
 * got no frame at all and the same sign-out.
 *
 * Run over the REAL auth store (`refresh`, its latches and its announcement), the REAL delivery API's
 * revocation check, the REAL frame answer and session-end reaction, and the REAL wipe - stand-ins only
 * for the network, the stores the wipe deletes, and the platform client. No clock: the wipe is held
 * by a deferred promise where an ordering is under test.
 */

const currentUserId = vi.fn<() => string | null>(() => 'alice');
vi.mock('$lib/stores/user', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/user')>()),
  currentUserId: () => currentUserId(),
  clearUserLocally: vi.fn(),
  saveUserLocally: vi.fn(),
}));

const storage = new Proxy({} as Record<string | symbol, unknown>, {
  get: (target, key) => (key === 'then' ? undefined : (target[key] ??= vi.fn(async () => []))),
}) as unknown as IStorage;
vi.mock('$lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/db')>()),
  getStorage: vi.fn(async () => storage),
}));

const removeMlsState = vi.fn(async (_userId: string) => {});
vi.mock('$lib/utils/hex', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/hex')>()),
  removeMlsState: (userId: string) => removeMlsState(userId),
}));

/** The factory reset - the last erasing step of the wipe, and what this file counts. */
let factoryHeld: Promise<void> | null = null;
const wipeDeviceToFactory = vi.fn(async (): Promise<string[]> => {
  if (factoryHeld) await factoryHeld;
  return [];
});
vi.mock('$lib/utils/deviceReset', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/deviceReset')>()),
  wipeDeviceToFactory: () => wipeDeviceToFactory(),
}));

const { refresh, getToken, setToken, setSessionExpiredHandler, clearAuth } =
  await import('$lib/stores/auth');
const { endExpiredSession } = await import('./endExpiredSession');
const { ACCOUNT_KEY } = await import('$lib/utils/accountLocalKeys');
const { MlsDeliveryApi } = await import('$lib/mls-client/mlsDeliveryApi');
const { answerDeviceRevokedFrame, settleSessionEndByRevocationImpl } =
  await import('./sessionAuth');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function liveToken(): string {
  const claims = btoa(JSON.stringify({ sub: 'alice', exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `h.${claims}.s`;
}

/** What the server answers: the refresh, the revocation check, everything else. */
let refreshAnswer: () => Promise<Response>;
const fetchMock = vi.fn(async (url: string | URL | Request) => {
  const u = String(url);
  if (u.includes('/api/auth/refresh')) return refreshAnswer();
  // The revocation check, asked with the access token the revocation killed.
  if (u.includes('/revoked')) return Response.json({ statusCode: 401 }, { status: 401 });
  return new Response('', { status: 200 });
});
/**
 * This install's device id. A new one per case: a COMPLETED reset is remembered per device for the
 * module's life (that is the property one case pins), so each case revokes a device of its own.
 */
let localDevice = '';
let deviceSeq = 0;

/** core-service's refusal, naming the revoked device and its account (this one unless overridden). */
const refusalNaming =
  (userId = 'alice', deviceId?: string) =>
  () =>
    Promise.resolve(
      Response.json(
        {
          statusCode: 401,
          code: 'DEVICE_REVOKED_BY_OWNER',
          message: 'revoked',
          userId,
          deviceId: deviceId ?? localDevice,
        },
        { status: 401 }
      )
    );
const revokedRefusal = () => refusalNaming()();
const expiredRefusal = () => Promise.resolve(Response.json({ statusCode: 401 }, { status: 401 }));

/** A session context whose account starts as `userId` (empty: a cold start, no login yet). */
function session(userId = 'alice') {
  let account = userId;
  let wiping = false;
  const known: Partial<SessionContext> = {
    getUserId: () => account,
    setUserId: (v) => (account = v),
    isWipingRevokedDevice: () => wiping,
    setWipingRevokedDevice: (v) => (wiping = v),
    whenMlsRetired: async () => {},
    getStorage: () => null,
    getHistoryBaseUrl: () => 'https://example.test',
    timers: { reconnect: null, health: null, syncWatchdog: null, connectionWatchdog: null },
  };
  const ctx = new Proxy(known as Record<string | symbol, unknown>, {
    get: (target, key) => (key in target ? target[key] : (target[key] = vi.fn())),
  }) as unknown as SessionContext;
  // Every other callback is a no-op: the teardown before the wipe calls a dozen of them.
  const cb = new Proxy(
    { log: vi.fn(), conversations: new Map(), onSessionExpired: vi.fn() } as Record<
      string | symbol,
      unknown
    >,
    { get: (target, key) => (key in target ? target[key] : (target[key] = vi.fn())) }
  ) as unknown as ChatSessionCallbacks;
  // The delivery API as production builds it: the 401 rule renews through the auth store.
  const api = new MlsDeliveryApi({
    historyUrl: 'https://example.test',
    getToken: () => getToken(),
    refreshToken: () => refresh(),
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
  const mls = {
    resolveDeviceId: async () => localDevice,
    isDeviceRevoked: (u: string, d: string) => api.isDeviceRevoked(u, d),
  };
  // As the app shell wires it: the session-expired reaction settles a revocation first, reading the
  // account the refused credential belonged to (the saved user when no login has named one).
  let settled: Promise<boolean> = Promise.resolve(false);
  setSessionExpiredHandler(() => {
    settled = settleSessionEndByRevocationImpl(ctx, cb, ctx.getUserId() || currentUserId() || '');
  });
  return {
    ctx,
    cb,
    mls,
    settled: () => settled,
    logs: () => (cb.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n'),
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  wipeDeviceToFactory.mockClear();
  removeMlsState.mockClear();
  factoryHeld = null;
  currentUserId.mockReturnValue('alice');
  localDevice = `device-${++deviceSeq}`;
  localStorage.setItem(ACCOUNT_KEY.deviceId('alice'), localDevice);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  // A live credential, so no verdict of a previous case is latched.
  setToken(liveToken());
});

afterEach(() => {
  setSessionExpiredHandler(null);
});

describe('a device revoked by its owner while online', () => {
  it('frame first: the check meets the dead session, the refusal says why, ONE reset runs', async () => {
    refreshAnswer = revokedRefusal;
    const s = session();

    await answerDeviceRevokedFrame(s.ctx, s.cb, s.mls);
    await expect(s.settled()).resolves.toBe(true);

    expect(wipeDeviceToFactory).toHaveBeenCalledTimes(1);
    expect(s.logs()).not.toContain('server disagrees');
    expect(s.logs()).toContain(
      '[SECURITY] This device was revoked by its owner - signing out and resetting.'
    );
    expect(s.logs()).toContain('Revoked-device reset already running - joined');
    // Then the user is handed to the session-expired seam, after the reset.
    expect(s.cb.onSessionExpired).toHaveBeenCalledTimes(1);
    // ...and says the reset already signed out, so the handler redirects without a second logout.
    expect(s.cb.onSessionExpired).toHaveBeenCalledWith({ alreadySignedOut: true });
  });

  it('refusal first: a request meets the dead session, then the frame arrives - the same ONE reset', async () => {
    refreshAnswer = revokedRefusal;
    const held = deferred();
    factoryHeld = held.promise;
    const s = session();

    // Any request: its renewal is refused, and the reaction starts the reset.
    await refresh().catch(() => {});
    // The frame, while that reset is still running.
    const frame = answerDeviceRevokedFrame(s.ctx, s.cb, s.mls);
    held.resolve();
    await frame;
    await expect(s.settled()).resolves.toBe(true);

    expect(wipeDeviceToFactory).toHaveBeenCalledTimes(1);
    expect(s.logs()).not.toContain('server disagrees');
    // The frame's check was answered from the latched refusal, without asking the server again.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/revoked'))).toHaveLength(0);
  });
});

describe('a device revoked by its owner while offline (DEV-3)', () => {
  it('its first request after the return resets it, on a cold start no login has named', async () => {
    refreshAnswer = revokedRefusal;
    const s = session('');

    await refresh().catch(() => {});
    await expect(s.settled()).resolves.toBe(true);

    expect(wipeDeviceToFactory).toHaveBeenCalledTimes(1);
    // The account reset is the refused credential's - never an empty one.
    expect(removeMlsState).toHaveBeenCalledWith('alice');
  });
});

describe('a reset that already ran', () => {
  it('a discoverer arriving after it completed erases nothing again', async () => {
    refreshAnswer = revokedRefusal;
    const s = session();
    await refresh().catch(() => {});
    await expect(s.settled()).resolves.toBe(true);
    expect(wipeDeviceToFactory).toHaveBeenCalledTimes(1);

    // The wipe removed the stored id; a late frame of the same revocation names the same device.
    localStorage.setItem(ACCOUNT_KEY.deviceId('alice'), localDevice);
    await answerDeviceRevokedFrame(s.ctx, s.cb, s.mls);
    // And the verdict replayed to a handler registered late.
    await settleSessionEndByRevocationImpl(s.ctx, s.cb, 'alice');

    expect(wipeDeviceToFactory).toHaveBeenCalledTimes(1);
    expect(s.logs()).toContain('Revoked-device reset already done for this device');
  });
});

describe('a revocation that is not THIS device', () => {
  it('a session bound to an id this install rotated away from - signs out, resets nothing', async () => {
    // The session was opened as device D1; the install has rotated to its current id since.
    refreshAnswer = refusalNaming('alice', 'device-rotated-away');
    const s = session();

    await answerDeviceRevokedFrame(s.ctx, s.cb, s.mls);
    await expect(s.settled()).resolves.toBe(false);

    expect(wipeDeviceToFactory).not.toHaveBeenCalled();
    expect(s.logs()).toContain('not this device');
    // The frame's own check is told the truth: the device asked about is not revoked.
    expect(s.logs()).toContain('server disagrees');
  });

  it("another account's device - signs out, resets nothing", async () => {
    refreshAnswer = refusalNaming('bob');
    const s = session();

    await refresh().catch(() => {});
    await expect(s.settled()).resolves.toBe(false);

    expect(wipeDeviceToFactory).not.toHaveBeenCalled();
    expect(removeMlsState).not.toHaveBeenCalled();
    expect(s.logs()).toContain('not this device');
  });
});

describe('what never resets anything', () => {
  it('a transport failure - the frame is not believed and the session is not judged', async () => {
    refreshAnswer = () => Promise.reject(new TypeError('Failed to fetch'));
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch');
    });
    const s = session();

    await answerDeviceRevokedFrame(s.ctx, s.cb, s.mls);
    await refresh().catch(() => {});

    await expect(s.settled()).resolves.toBe(false);
    expect(wipeDeviceToFactory).not.toHaveBeenCalled();
  });

  it('a session that died any other way - it signs out and keeps its stores', async () => {
    refreshAnswer = expiredRefusal;
    const s = session();

    await answerDeviceRevokedFrame(s.ctx, s.cb, s.mls);
    await expect(s.settled()).resolves.toBe(false);

    expect(wipeDeviceToFactory).not.toHaveBeenCalled();
    expect(s.logs()).toContain('server disagrees');
  });
});

/**
 * A REVOKED DEVICE SIGNS OUT EXACTLY ONCE - counted on the wire, through the real decision.
 *
 * The count is `POST /api/auth/logout` requests: the reset's own `clearAuth` is the sign-out, and
 * `endExpiredSession` (the session-expired handler's decision) adds none when the reset has run. The
 * handler is wired as the app shell wires it, and every discoverer's promise is awaited.
 */
describe('the sign-out count of a session that died', () => {
  const logouts = () =>
    fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/auth/logout'));

  /** The app shell's wiring: the notifier and the callback seam both reach `endExpiredSession`. */
  function app() {
    const s = session();
    const running: Promise<unknown>[] = [];
    const handle = (outcome?: { alreadySignedOut?: boolean }) => {
      running.push(
        endExpiredSession({
          outcome,
          settleRevocation: () =>
            settleSessionEndByRevocationImpl(s.ctx, s.cb, s.ctx.getUserId() || 'alice'),
          signOut: clearAuth,
          loginPath: '/login',
          log: (m) => (s.cb.log as (m: string) => void)(m),
        })
      );
    };
    setSessionExpiredHandler(() => handle());
    (s.cb as unknown as { onSessionExpired: typeof handle }).onSessionExpired = handle;
    return { ...s, settleAll: () => Promise.all(running) };
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('frame first: one logout', async () => {
    refreshAnswer = revokedRefusal;
    const a = app();
    await answerDeviceRevokedFrame(a.ctx, a.cb, a.mls);
    await a.settleAll();
    expect(wipeDeviceToFactory).toHaveBeenCalledTimes(1);
    expect(logouts()).toHaveLength(1);
  });

  it('refusal first: one logout', async () => {
    refreshAnswer = revokedRefusal;
    const a = app();
    await refresh().catch(() => {});
    await answerDeviceRevokedFrame(a.ctx, a.cb, a.mls);
    await a.settleAll();
    expect(wipeDeviceToFactory).toHaveBeenCalledTimes(1);
    expect(logouts()).toHaveLength(1);
  });

  it('a rotated device id (not this device): one logout, nothing reset', async () => {
    refreshAnswer = refusalNaming('alice', 'device-rotated-away');
    const a = app();
    await refresh().catch(() => {});
    await a.settleAll();
    expect(wipeDeviceToFactory).not.toHaveBeenCalled();
    expect(logouts()).toHaveLength(1);
  });

  it("another account's device (not this device): one logout, nothing reset", async () => {
    refreshAnswer = refusalNaming('bob');
    const a = app();
    await refresh().catch(() => {});
    await a.settleAll();
    expect(wipeDeviceToFactory).not.toHaveBeenCalled();
    expect(logouts()).toHaveLength(1);
  });

  it('a plain expiry: one logout', async () => {
    refreshAnswer = expiredRefusal;
    const a = app();
    await refresh().catch(() => {});
    await a.settleAll();
    expect(logouts()).toHaveLength(1);
  });

  it('a reset that throws BEFORE its clearAuth: still one logout, never zero', async () => {
    refreshAnswer = revokedRefusal;
    removeMlsState.mockRejectedValueOnce(new Error('store locked'));
    const a = app();
    await refresh().catch(() => {});
    await a.settleAll();
    expect(logouts()).toHaveLength(1);
  });

  it('a reset that throws AFTER its clearAuth: TWO logouts - the accepted case, a harmless write on a gone session', async () => {
    refreshAnswer = revokedRefusal;
    wipeDeviceToFactory.mockRejectedValueOnce(new Error('factory reset failed'));
    const a = app();
    await refresh().catch(() => {});
    await a.settleAll();
    expect(logouts()).toHaveLength(2);
  });

  it('a refusal reaching the handler MID-WIPE joins it: no false "not this device", no second logout', async () => {
    refreshAnswer = revokedRefusal;
    const held = deferred();
    factoryHeld = held.promise;
    const a = app();
    // The first discoverer starts the wipe, which parks on the held factory reset.
    await refresh().catch(() => {});
    await vi.waitFor(() => expect(localStorage.getItem(ACCOUNT_KEY.deviceId('alice'))).toBeNull());
    // The wipe has deleted the key the identity comparison reads; a second refusal arrives now.
    const second = settleSessionEndByRevocationImpl(a.ctx, a.cb, 'alice');
    held.resolve();
    await expect(second).resolves.toBe(true);
    await a.settleAll();
    expect(a.logs()).not.toContain('not this device');
    expect(wipeDeviceToFactory).toHaveBeenCalledTimes(1);
    expect(logouts()).toHaveLength(1);
  });
});
