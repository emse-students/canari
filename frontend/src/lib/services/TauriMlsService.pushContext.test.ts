// @vitest-environment happy-dom
// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));
/** The sign-out generation `auth.ts` counts; a test bumps it to start a sign-out. */
let signOuts = 0;
vi.mock('$lib/stores/auth', () => ({
  getToken: vi.fn().mockResolvedValue('bearer'),
  signOutGeneration: () => signOuts,
}));

import { TauriMlsService } from './TauriMlsService';

/**
 * EVERY SIGN-IN WRITES THE PUSH CONTEXT, THE BIOMETRIC ONE INCLUDED (2026-11-07).
 *
 * A sign-out strips `push_context.json` to its identity keys - no `baseUrl` - and the biometric
 * sign-in skipped `store_push_context` whole (its key is empty), so a phone that signed out and
 * back in by fingerprint kept the stripped file and every push showed the generic banner
 * ([content-free-push](../../../../docs/wiki/protocols/content-free-push.md)). The biometric init
 * now writes the session's file and hands NO key, so the keystore entry it read is left alone.
 */
interface ServiceInternals {
  deviceId: string;
  _initImpl(userId: string, deviceKeyB64: string, state?: Uint8Array): Promise<void>;
}

const KEY = 'k'.repeat(43) + '=';

/** The `store_push_context` calls, once the fire-and-forget chain after init has settled. */
async function pushContextWrites(): Promise<Record<string, unknown>[]> {
  await vi.waitFor(() =>
    expect(invoke.mock.calls.some((c) => c[0] === 'store_push_context')).toBe(true)
  );
  return invoke.mock.calls
    .filter((c) => c[0] === 'store_push_context')
    .map((c) => c[1] as Record<string, unknown>);
}

describe('TauriMlsService init - the push context', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    signOuts = 0;
    localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  function makeService(): ServiceInternals {
    const svc = new TauriMlsService() as unknown as ServiceInternals;
    svc.deviceId = 'device-1';
    return svc;
  }

  it('a BIOMETRIC sign-in (no key in hand) writes the session context, with no key', async () => {
    await makeService()._initImpl('user-1', '');

    const [write] = await pushContextWrites();
    expect(write).toMatchObject({
      deviceKeyB64: null,
      userId: 'user-1',
      deviceId: 'device-1',
      pushToken: 'bearer',
    });
    expect(typeof write.baseUrl).toBe('string');
    expect(write.baseUrl).not.toBe('');
  });

  it('a PIN sign-in hands its key, which the native side puts in the keystore', async () => {
    await makeService()._initImpl('user-1', KEY);

    const [write] = await pushContextWrites();
    expect(write).toMatchObject({ deviceKeyB64: KEY, userId: 'user-1', deviceId: 'device-1' });
  });

  it.each([
    ['biometric', ''],
    ['PIN', KEY],
  ])(
    'a %s sign-in whose save a sign-out overtakes writes NO context - it would undo the strip',
    async (_path, key) => {
      // The sign-out lands while `mls.bin` is being saved, the await the write is chained on.
      let saved: () => void = () => {};
      invoke.mockImplementation((cmd: string) =>
        cmd === 'sauvegarder_mls_et_persister'
          ? new Promise<number>((resolve) => {
              saved = () => resolve(1);
            })
          : Promise.resolve(undefined)
      );
      await makeService()._initImpl('user-1', key);

      signOuts += 1;
      saved();

      await vi.waitFor(() =>
        expect(console.log).toHaveBeenCalledWith(
          expect.stringContaining('push_context write after init dropped')
        )
      );
      expect(invoke.mock.calls.some((c) => c[0] === 'store_push_context')).toBe(false);
    }
  );
});
