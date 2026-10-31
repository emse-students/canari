// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IMlsService } from '$lib/mls-client';
import type { MlsStatePersister } from '$lib/mls-client/mlsStatePersister';
import type { ChatSessionCallbacks, SessionContext } from './sessionTypes';
import { flushMacrotask } from '../../../test/flush';

/**
 * Account A signs out while its final MLS checkpoint is still being written, account B signs in on
 * the same process, and A's write lands late - replayed over the REAL composable
 * (`useChatSession`: its MLS holder, its `initServices`, its `endSession`), the real `clearAuth`,
 * the real persister registry and the real lifecycle hooks. Only the platform client, the call
 * service class and the encrypt worker are stand-ins.
 *
 * What B must still hold once A's write lands: its own client (not destroyed, not A's), a call
 * service built over that client, its own persister registered, its own backgrounding hook, and the
 * shared encrypt worker. `loginImpl` waits for the retirement; the first case is a path that did
 * NOT wait, so the ownership guards are what is asserted, not the ordering.
 */

vi.mock('$lib/stores/user', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/user')>()),
  currentUserId: () => 'user-a',
  clearUserLocally: vi.fn(),
}));

type FakeClient = {
  pauseSocket: ReturnType<typeof vi.fn>;
  isWsOpen: () => boolean;
  destroy: ReturnType<typeof vi.fn>;
};
const made: FakeClient[] = [];
vi.mock('$lib/mlsService', () => ({
  createMlsService: () => {
    const client: FakeClient = { pauseSocket: vi.fn(), isWsOpen: () => false, destroy: vi.fn() };
    made.push(client);
    return client;
  },
}));

vi.mock('$lib/services/CallService', () => ({
  CallService: class {
    readonly callState = { subscribe: () => () => {} };
    readonly retireFromPageRing = vi.fn();
    constructor(readonly mls: IMlsService) {}
    setChatNotifier() {}
  },
}));

const disposeMlsEncryptWorker = vi.fn();
vi.mock('$lib/mls-client/mlsEncryptWorkerSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/mlsEncryptWorkerSession')>()),
  disposeMlsEncryptWorker,
}));

// THE ONE FACT FAKED IN THE SESSION: that it is live. The composable has no way to mark a session
// signed in short of running a whole login, so the real `endSessionImpl` gets the real context with
// `isLoggedIn` answered from a flag that the teardown's own `setIsLoggedIn(false)` clears.
let live = false;
vi.mock('./sessionAuth', async (importOriginal) => {
  const real = await importOriginal<typeof import('./sessionAuth')>();
  return {
    ...real,
    endSessionImpl: (ctx: SessionContext, cb: ChatSessionCallbacks) =>
      real.endSessionImpl(
        {
          ...ctx,
          isLoggedIn: () => live,
          setIsLoggedIn: (v: boolean) => {
            live = v;
            ctx.setIsLoggedIn(v);
          },
        },
        cb
      ),
  };
});

const { clearAuth, setSignOutHandler } = await import('$lib/stores/auth');
const { useChatSession } = await import('../useChatSession.svelte');
const { registerMlsStatePersister, unregisterMlsStatePersister, activeMlsStatePersister } =
  await import('$lib/mls-client/mlsStatePersisterRegistry');
const { installMlsStatePersisterLifecycle, uninstallMlsStatePersisterLifecycle } =
  await import('$lib/mls-client/mlsStatePersisterLifecycle');
const { APP_FOREGROUND_EVENT } = await import('$lib/utils/appForeground');

/** A persister whose flush lands only when the test says so (A's), or at once (B's). */
function persister(held: boolean) {
  let land: (fail?: Error) => void = () => {};
  const flushEncrypted = vi.fn(() =>
    held
      ? new Promise<void>((resolve, reject) => (land = (fail) => (fail ? reject(fail) : resolve())))
      : Promise.resolve()
  );
  const p = {
    persistNow: vi.fn(),
    scheduleDeferred: vi.fn(),
    flush: vi.fn(async () => {}),
    flushEncrypted,
    onBulkIngestStart: vi.fn(),
    onBulkIngestEnd: vi.fn(async () => {}),
  } as unknown as MlsStatePersister;
  return { p, flushEncrypted, land: (fail?: Error) => land(fail) };
}

const background = () =>
  window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: false } }));
const settle = () => flushMacrotask();

/** Account A, signed in: its client, its call service, its persister and hooks, a live session. */
function signedInAsA() {
  made.length = 0;
  disposeMlsEncryptWorker.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 200 }))
  );
  const session = useChatSession();
  session.initServices(() => {});
  const clientA = made[0];
  const a = persister(true);
  registerMlsStatePersister(a.p);
  installMlsStatePersisterLifecycle(a.p);
  live = true;
  const cb = {
    log: vi.fn(),
    conversations: new Map(),
    invalidateRestores: vi.fn(),
    forgetUnconfirmedSalonDraws: vi.fn(),
    setSelectedContact: vi.fn(),
  } as unknown as ChatSessionCallbacks;
  setSignOutHandler(() => session.endSession(cb));
  return { session, clientA, a };
}

afterEach(() => {
  setSignOutHandler(null);
  uninstallMlsStatePersisterLifecycle();
  unregisterMlsStatePersister();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("A signs out with its final write held, B signs in, A's write lands late", () => {
  it('B keeps its client, its call service, its persister, its hooks and the encrypt worker', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { session, clientA, a } = signedInAsA();
    expect(session.callService.mls).toBe(clientA);

    // A signs out; its final checkpoint is in flight and stays there.
    await clearAuth();
    expect(clientA.pauseSocket).toHaveBeenCalledTimes(1);
    expect(a.flushEncrypted).toHaveBeenCalledTimes(1);

    // B arrives: the shell runs `initServices` before the login flow, during A's write.
    const callServiceA = session.callService;
    session.initServices(() => {});
    // A's call service withdraws what it told the native ring before it is replaced.
    expect(callServiceA.retireFromPageRing).toHaveBeenCalledTimes(1);
    const clientB = made[1];
    expect(clientB).toBeDefined();
    expect(session.ensureMls()).toBe(clientB);
    expect(session.callService.mls).toBe(clientB);

    // A path that did NOT wait registers B's persister and hooks before A's write lands.
    const b = persister(false);
    registerMlsStatePersister(b.p);
    installMlsStatePersisterLifecycle(b.p);

    // A's write lands late.
    a.land();
    await settle();

    expect(clientA.destroy).toHaveBeenCalledTimes(1);
    expect(clientB.destroy).not.toHaveBeenCalled();
    expect(session.ensureMls()).toBe(clientB);
    expect(session.callService.mls).toBe(clientB);
    expect(activeMlsStatePersister()).toBe(b.p);
    expect(disposeMlsEncryptWorker).not.toHaveBeenCalled();
    background();
    expect(b.flushEncrypted).toHaveBeenCalledTimes(1);
    expect(a.flushEncrypted).toHaveBeenCalledTimes(1);
  });

  it('a final write that FAILS still retires A and releases what A registered', async () => {
    const { session, clientA, a } = signedInAsA();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await clearAuth();

    a.land(new Error('disk full'));
    await settle();

    expect(errors.mock.calls.flat().join('\n')).toContain('Final MLS checkpoint failed');
    expect(clientA.destroy).toHaveBeenCalledTimes(1);
    expect(session.ensureMls()).not.toBe(clientA);
    // Nobody registered since: the persister goes, and the encrypt worker with it.
    expect(activeMlsStatePersister()).toBeNull();
    expect(disposeMlsEncryptWorker).toHaveBeenCalledTimes(1);
  });
});
