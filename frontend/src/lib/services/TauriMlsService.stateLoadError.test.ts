// @vitest-environment happy-dom
// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));
vi.mock('$lib/stores/auth', () => ({ getToken: vi.fn().mockResolvedValue('') }));

import { isKeystoreKeyUnavailable } from '$lib/mls-client';
import {
  KeystoreKeyUnavailableError,
  MlsStateLoadUntypedError,
} from '$lib/mls-client/mlsStateLoadError';
import { MlsStateVerdictError } from '$lib/mls-client/mlsStateSeal';
import { TauriMlsService } from './TauriMlsService';

/**
 * `initialiser_mls` rejects with `mls-core`'s `StateLoadRefusal` - `{ code, message }` - and
 * `TauriMlsService` types it AT THE INVOKE BOUNDARY. What the classifier then reads is the TYPE, so
 * a refusal whose message names a code but whose `code` field does not carry it is `unknown`.
 */
interface ServiceInternals {
  deviceId: string;
  userId: string;
  loadStateWithKey(deviceKeyB64: string, state?: Uint8Array, stateOnDisk?: boolean): Promise<void>;
  classifyStateLoadFailure(error: unknown): string;
}

function makeService(): ServiceInternals {
  const svc = new TauriMlsService() as unknown as ServiceInternals;
  svc.deviceId = 'bob-device';
  svc.userId = 'bob';
  return svc;
}

/** `initialiser_mls` rejects with `rejection`; everything else resolves. */
function initRejects(rejection: unknown): void {
  invoke.mockImplementation((cmd: string) =>
    cmd === 'initialiser_mls' ? Promise.reject(rejection) : Promise.resolve(undefined)
  );
}

async function loadError(svc: ServiceInternals): Promise<unknown> {
  return svc.loadStateWithKey('k'.repeat(44), undefined, true).then(
    () => {
      throw new Error('the load was expected to fail');
    },
    (e: unknown) => e
  );
}

describe('TauriMlsService - initialiser_mls refusals are typed at the invoke boundary', () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['STATE_ALTERED', 'altered'],
    ['STATE_KEY_MISMATCH', 'rotated'],
    ['STATE_UNDECRYPTABLE', 'undecryptable'],
    ['IDENTITY_MISMATCH', 'mismatch'],
  ] as const)(
    'maps the code field %s to MlsStateVerdictError, classified %s',
    async (code, cause) => {
      initRejects({ code, message: 'the text is for the logs' });
      const svc = makeService();
      const error = await loadError(svc);
      expect(error).toBeInstanceOf(MlsStateVerdictError);
      expect((error as MlsStateVerdictError).code).toBe(code);
      expect(svc.classifyStateLoadFailure(error)).toBe(cause);
    }
  );

  it('maps KEYSTORE_KEY_UNAVAILABLE to its type, which the login reads', async () => {
    initRejects({ code: 'KEYSTORE_KEY_UNAVAILABLE', message: 'no key' });
    const svc = makeService();
    const error = await loadError(svc);
    expect(error).toBeInstanceOf(KeystoreKeyUnavailableError);
    expect(isKeystoreKeyUnavailable(error)).toBe(true);
    expect(svc.classifyStateLoadFailure(error)).toBe('keystore_unavailable');
  });

  it('a MESSAGE naming a code with a null code field is unknown - the text proves nothing', async () => {
    initRejects({ code: null, message: 'STATE_ALTERED: Failed to lock state' });
    const svc = makeService();
    const error = await loadError(svc);
    expect(error).toBeInstanceOf(MlsStateLoadUntypedError);
    expect(svc.classifyStateLoadFailure(error)).toBe('unknown');
    expect(isKeystoreKeyUnavailable(error)).toBe(false);
  });

  it('the OLD string rejection is unknown too, and accused - no older shape is understood', async () => {
    initRejects('KEYSTORE_KEY_UNAVAILABLE: no keystore key and no device_key_b64 provided');
    const svc = makeService();
    const error = await loadError(svc);
    expect(error).toBeInstanceOf(MlsStateLoadUntypedError);
    expect(isKeystoreKeyUnavailable(error)).toBe(false);
    expect(svc.classifyStateLoadFailure(error)).toBe('unknown');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('outside its { code, message } contract')
    );
  });
});
