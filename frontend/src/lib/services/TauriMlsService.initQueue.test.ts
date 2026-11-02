// @vitest-environment happy-dom
// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));
vi.mock('$lib/stores/auth', () => ({ getToken: vi.fn().mockResolvedValue('') }));
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

  it('starts the second attempt only after the first has failed AND ended its session', async () => {
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
    expect(calls).toEqual(['init:alice', 'terminer_session_mls', 'init:bob']);
  });
});
