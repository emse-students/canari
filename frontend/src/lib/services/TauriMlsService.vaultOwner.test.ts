// @vitest-environment happy-dom
// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));
vi.mock('$lib/stores/auth', () => ({ getToken: vi.fn().mockResolvedValue('') }));

import { VaultOwnerUnprovenError } from '$lib/mls-client';
import { TauriMlsService } from './TauriMlsService';

/**
 * A VAULT KEY OF UNPROVEN OWNER NEVER ROTATES A PHONE'S `mls.bin`.
 *
 * `mls.bin` is one file per install. Account A ticks "Rester connecte" and signs out; the vault, an
 * older build's single slot naming nobody, keeps A's key. Account B signs in, the vault path hands
 * B A's key, A's key OPENS `mls.bin`, and the credential inside names A: `IDENTITY_MISMATCH`. The
 * `mismatch` branch then rotated the device identity and wrote a fresh state over the file - A's
 * whole local state, gone, for a sign-in that was not A's ([auth](../../../../docs/wiki/frontend/modules/auth.md)).
 *
 * With `vaultOwnerUnproven` the same load is refused, typed, and NOTHING after it runs: no rotation,
 * no second `initialiser_mls`, no write of any kind.
 */
interface ServiceInternals {
  deviceId: string;
  rotateDeviceIdentity(deviceKeyB64: string, reason: string): Promise<string>;
  _initImpl(
    userId: string,
    deviceKeyB64: string,
    state?: Uint8Array,
    opts?: {
      noFreshStart?: boolean;
      stateOnDisk?: boolean;
      legacyPin?: string;
      vaultOwnerUnproven?: boolean;
    }
  ): Promise<void>;
}

const BOB = 'bob';
const ALICES_KEY = 'a'.repeat(44);

/** Every native command that writes `mls.bin` or the push context. */
const WRITES = ['sauvegarder_mls_et_persister', 'store_push_context'];

function makeService(): ServiceInternals {
  const svc = new TauriMlsService() as unknown as ServiceInternals;
  svc.deviceId = 'bob-device';
  return svc;
}

/** `mls.bin` holds Alice's state: her key opens it, and its credential names her. */
function mlsBinIsAlices(): void {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'sauvegarder_mls_et_persister') return Promise.resolve([1, 2, 3]);
    if (cmd === 'initialiser_mls') {
      return Promise.reject({
        code: 'IDENTITY_MISMATCH',
        message: 'IDENTITY_MISMATCH: expected bob:bob-device but state contains alice:alice-device',
      });
    }
    return Promise.resolve(undefined);
  });
}

const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd).length;

describe('TauriMlsService init - a vault key whose owner is not proven', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it("REFUSES another account's mls.bin, typed, and rotates nothing", async () => {
    mlsBinIsAlices();
    const svc = makeService();
    const rotate = vi.spyOn(svc, 'rotateDeviceIdentity');

    const refused = svc._initImpl(BOB, ALICES_KEY, undefined, {
      noFreshStart: true,
      stateOnDisk: true,
      vaultOwnerUnproven: true,
    });

    await expect(refused).rejects.toBeInstanceOf(VaultOwnerUnprovenError);
    await expect(refused).rejects.toMatchObject({ refusal: 'mismatch' });
    expect(rotate).not.toHaveBeenCalled();
    // ONE load, and nothing after it: a second init is the rotation's, a save is its checkpoint.
    expect(calls('initialiser_mls')).toBe(1);
    for (const cmd of WRITES) expect(calls(cmd), cmd).toBe(0);
  });

  it('CONTROL: the same load with a PROVEN key still rotates - the guard is what changed', async () => {
    // A proven key that opens a state naming another device of the SAME account is the old,
    // deliberate recovery, and it must keep working. It is also what proves the case above is
    // not passing because the mocks could never reach a rotation.
    mlsBinIsAlices();
    const svc = makeService();
    const rotate = vi.spyOn(svc, 'rotateDeviceIdentity').mockResolvedValue('rotated');

    await svc._initImpl(BOB, ALICES_KEY, undefined, { noFreshStart: true, stateOnDisk: true });

    expect(rotate).toHaveBeenCalledTimes(1);
  });

  it('refuses a state that will not open under the key, and runs no legacy re-seal', async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === 'initialiser_mls'
        ? Promise.reject({
            code: 'STATE_UNDECRYPTABLE',
            message: 'STATE_UNDECRYPTABLE: aead::Error',
          })
        : Promise.resolve(undefined)
    );
    const svc = makeService();

    await expect(
      svc._initImpl(BOB, ALICES_KEY, undefined, {
        noFreshStart: true,
        stateOnDisk: true,
        legacyPin: '1234',
        vaultOwnerUnproven: true,
      })
    ).rejects.toMatchObject({ refusal: 'unopenable' });
    // The legacy retry PERSISTS a re-sealed mls.bin; it must not run on a key nobody owns.
    expect(calls('initialiser_mls')).toBe(1);
  });

  it('refuses with no state at all, before any native call - a fresh start would seal under it', async () => {
    const svc = makeService();

    await expect(
      svc._initImpl(BOB, ALICES_KEY, undefined, { vaultOwnerUnproven: true })
    ).rejects.toMatchObject({ refusal: 'no_state' });
    expect(calls('initialiser_mls')).toBe(0);
    for (const cmd of WRITES) expect(calls(cmd), cmd).toBe(0);
  });

  it('accepts the key when it opens a state naming this account - the owner is then proven', async () => {
    const svc = makeService();
    const rotate = vi.spyOn(svc, 'rotateDeviceIdentity');

    await svc._initImpl('alice', ALICES_KEY, undefined, {
      noFreshStart: true,
      stateOnDisk: true,
      vaultOwnerUnproven: true,
    });

    expect(rotate).not.toHaveBeenCalled();
    expect(calls('initialiser_mls')).toBe(1);
  });
});
