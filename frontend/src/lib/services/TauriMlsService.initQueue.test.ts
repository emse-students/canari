// @vitest-environment happy-dom
// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));
vi.mock('$lib/stores/auth', () => ({
  getToken: vi.fn().mockResolvedValue(''),
  signOutGeneration: () => 0,
}));
// The failed attempt's teardown runs only in a native runtime.
vi.mock('$lib/utils/tauriRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/tauriRuntime')>()),
  isTauriRuntime: () => true,
}));

import { TauriMlsService } from './TauriMlsService';

/**
 * Round 3 of the review of #2919: two `initialiser_mls` of one page never overlap in the native
 * session - a failed attempt's teardown (`terminer_session_mls`) included. Run beside another
 * attempt, that end would land in the middle of the other's load.
 */
interface ServiceInternals {
  deviceId: string;
  userId: string;
  loadStateWithKey(deviceKeyB64: string, state?: Uint8Array, stateOnDisk?: boolean): Promise<void>;
}

function makeService(userId: string): ServiceInternals {
  const svc = new TauriMlsService() as unknown as ServiceInternals;
  svc.deviceId = `${userId}-device`;
  svc.userId = userId;
  return svc;
}

describe('TauriMlsService - initialiser_mls runs one at a time', () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('starts the second attempt only after the first has failed, and ends no session from the page', async () => {
    const calls: string[] = [];
    let rejectFirst: (e: unknown) => void = () => {};
    invoke.mockImplementation((cmd: string, args?: { userId?: string }) => {
      calls.push(cmd === 'initialiser_mls' ? `init:${args?.userId}` : cmd);
      if (cmd === 'initialiser_mls' && args?.userId === 'alice') {
        return new Promise((_, reject) => {
          rejectFirst = reject;
        });
      }
      return Promise.resolve(undefined);
    });

    const first = makeService('alice')
      .loadStateWithKey('k'.repeat(44), undefined, true)
      .catch((e: unknown) => e);
    const second = makeService('bob').loadStateWithKey('k'.repeat(44), undefined, true);

    // Let every microtask run: the second attempt must still be waiting on the first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['init:alice']);

    rejectFirst({ code: 'KEYSTORE_KEY_UNAVAILABLE', message: 'sheet cancelled' });
    await first;
    await second;
    expect(calls).toEqual(['init:alice', 'init:bob']);
  });

  it('after a reload (a second page, its own queue), a refused sign-in does not end the previous page loading', async () => {
    const calls: string[] = [];
    let finishFirst: () => void = () => {};
    invoke.mockImplementation((cmd: string, args?: { userId?: string }) => {
      calls.push(cmd === 'initialiser_mls' ? `init:${args?.userId}` : cmd);
      if (cmd === 'initialiser_mls' && args?.userId === 'alice') {
        return new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      }
      if (cmd === 'initialiser_mls') {
        return Promise.reject({ code: null, message: 'a foreground MLS session is still open' });
      }
      return Promise.resolve(undefined);
    });

    // The previous page: its sign-in is loading natively when the page goes away.
    const loading = makeService('alice').loadStateWithKey('k'.repeat(44), undefined, true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The reloaded page: a fresh module, so a fresh queue - nothing orders it after the first.
    vi.resetModules();
    const { TauriMlsService: ReloadedService } = await import('./TauriMlsService');
    const reloaded = new ReloadedService() as unknown as ServiceInternals;
    reloaded.deviceId = 'bob-device';
    reloaded.userId = 'bob';
    const refused = await reloaded.loadStateWithKey('k'.repeat(44), undefined, true).then(
      () => null,
      (e: unknown) => e
    );

    expect(refused).not.toBeNull();
    // The reloaded app's other modules answer their own commands; only the session's are read here.
    const session = calls.filter((c) => c.startsWith('init:') || c === 'terminer_session_mls');
    expect(session).toEqual(['init:alice', 'init:bob']);
    finishFirst();
    await loading;
  });
});

/**
 * Round 4 of the review of #2919: `initialiser_mls` refuses a fresh start over a saved state
 * whatever the selection, so the device identity rotation - the one fresh start that means to replace
 * the state that did not open - says so, and nothing else does.
 */
describe("TauriMlsService - the rotation's fresh start says it replaces the saved state", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const optsOfInit = () =>
    invoke.mock.calls.find((c) => c[0] === 'initialiser_mls')?.[1]?.opts as
      | { replacesUnopenedState: boolean; stateOnDisk: boolean }
      | undefined;

  it('the rotation asks for the replacement', async () => {
    const svc = makeService('alice') as unknown as {
      loadFreshStateReplacingUnopened(key: string): Promise<void>;
    };
    await svc.loadFreshStateReplacingUnopened('k'.repeat(44));
    expect(optsOfInit()).toMatchObject({ replacesUnopenedState: true, stateOnDisk: false });
  });

  it('an ordinary load never does', async () => {
    await makeService('alice').loadStateWithKey('k'.repeat(44), undefined, true);
    expect(optsOfInit()).toMatchObject({ replacesUnopenedState: false });
  });
});
