// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));
vi.mock('$lib/stores/auth', () => ({ getToken: vi.fn().mockResolvedValue('') }));

import { MLS_LOCAL_STATE_UNDECRYPTABLE } from '$lib/mls-client';
import { TauriMlsService } from './TauriMlsService';

/**
 * `mls.bin` STAYS ON DISK, AND "NOT PASSED" MUST NOT READ AS "NOT THERE".
 *
 * Until 2026-09-15 the login path loaded the blob (7,8 MB on a real account) only to hand it
 * straight back to Rust through the IPC bridge, as a JSON array of per-byte numbers - 29 074 883
 * characters per crossing, twice, blocking the main thread for 2 731 ms of a cold launch. The fix
 * is to stop sending it. What that costs is the one fact `encryptedState` used to carry for free:
 * an absent array meant FIRST INSTALL, and first install is destructive - it rotates the device
 * identity and resets the send-ratchet ledger. `stateOnDisk` is the flag that separates the two,
 * and every assertion below is about that separation rather than about the saving.
 */
interface ServiceInternals {
  freshStart: boolean;
  deviceId: string;
  _initImpl(
    userId: string,
    deviceKeyB64: string,
    state?: Uint8Array,
    opts?: { noFreshStart?: boolean; stateOnDisk?: boolean; legacyPin?: string }
  ): Promise<void>;
}

const USER = 'user-1';
const KEY = 'k'.repeat(44);

function makeService(): ServiceInternals {
  const svc = new TauriMlsService() as unknown as ServiceInternals;
  svc.deviceId = 'device-1';
  return svc;
}

/** The arguments of the single `initialiser_mls` call. */
function initArgs(): {
  encryptedState: number[] | null;
  opts: { stateOnDisk: boolean };
} {
  const call = invoke.mock.calls.find((c) => c[0] === 'initialiser_mls');
  expect(call, 'initialiser_mls was never invoked').toBeTruthy();
  return call![1] as { encryptedState: number[] | null; opts: { stateOnDisk: boolean } };
}

describe('TauriMlsService init - the state that is on disk and never crosses the bridge', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    localStorage.clear();
  });

  it('sends no bytes and tells Rust to read the file itself', async () => {
    const svc = makeService();
    await svc._initImpl(USER, KEY, undefined, { stateOnDisk: true });

    const args = initArgs();
    expect(args.encryptedState).toBeNull();
    expect(args.opts.stateOnDisk).toBe(true);
  });

  it('does NOT call it a fresh start when the bytes are absent but the state is on disk', async () => {
    const svc = makeService();
    await svc._initImpl(USER, KEY, undefined, { stateOnDisk: true });

    // A fresh start rotates the device identity and resets the send-ratchet ledger. Reading the
    // missing array as "no state" would do both to a device that has one.
    expect(svc.freshStart).toBe(false);
  });

  it('still calls it a fresh start when there is genuinely no state', async () => {
    const svc = makeService();
    await svc._initImpl(USER, KEY, undefined, {});

    expect(svc.freshStart).toBe(true);
    expect(initArgs().opts.stateOnDisk).toBe(false);
  });

  it('blames the state, not the caller, when a load fails with the state on disk', async () => {
    const svc = makeService();
    invoke.mockImplementation((cmd: string) =>
      cmd === 'initialiser_mls'
        ? Promise.reject(new Error('STATE_UNDECRYPTABLE'))
        : Promise.resolve(undefined)
    );

    // `noFreshStart` pauses for a PIN recovery ONLY when a saved state exists; with the state read
    // as absent, the raw error would propagate instead and the recovery would never be offered.
    await expect(
      svc._initImpl(USER, KEY, undefined, { noFreshStart: true, stateOnDisk: true })
    ).rejects.toThrow(MLS_LOCAL_STATE_UNDECRYPTABLE);
  });

  it('carries the flag through the legacy-envelope retry, which reloads the same file', async () => {
    const svc = makeService();
    let attempts = 0;
    invoke.mockImplementation((cmd: string) => {
      if (cmd !== 'initialiser_mls') return Promise.resolve(undefined);
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('STATE_UNDECRYPTABLE'))
        : Promise.resolve(undefined);
    });

    await svc._initImpl(USER, KEY, undefined, { stateOnDisk: true, legacyPin: '1234' });

    const retry = invoke.mock.calls.filter((c) => c[0] === 'initialiser_mls')[1];
    expect(retry, 'the legacy retry never ran').toBeTruthy();
    const opts = (retry![1] as { opts: { legacyPin: string; stateOnDisk: boolean } }).opts;
    expect(opts.legacyPin).toBe('1234');
    // The retry has no bytes of its own either: without the flag Rust would be handed nothing to
    // re-seal and the migration would "succeed" on an empty state.
    expect(opts.stateOnDisk).toBe(true);
  });

  it('never reads the disk for a device identity that has just been rotated', async () => {
    const svc = makeService();
    let attempts = 0;
    invoke.mockImplementation((cmd: string) => {
      // The rotation writes a checkpoint on its way out, and that command answers with bytes.
      if (cmd === 'sauvegarder_mls_et_persister') return Promise.resolve([1, 2, 3]);
      if (cmd !== 'initialiser_mls') return Promise.resolve(undefined);
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('IDENTITY_MISMATCH'))
        : Promise.resolve(undefined);
    });

    await svc._initImpl(USER, KEY, undefined, { stateOnDisk: true });

    // The rotation abandons the old identity and starts at generation zero; pointing the native
    // side back at the blob that names the abandoned device would undo exactly that.
    const rotated = invoke.mock.calls.filter((c) => c[0] === 'initialiser_mls')[1];
    expect(rotated, 'the rotation never re-initialised').toBeTruthy();
    expect((rotated![1] as { opts: { stateOnDisk: boolean } }).opts.stateOnDisk).toBe(false);
    expect((rotated![1] as { encryptedState: number[] | null }).encryptedState).toBeNull();
  });
});
