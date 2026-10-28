// @vitest-environment happy-dom
// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));
vi.mock('$lib/stores/auth', () => ({ getToken: vi.fn().mockResolvedValue('') }));

import {
  MlsSessionVacantError,
  SavedStateOfAnotherAccountError,
  SavedStateUnopenedError,
} from '$lib/mls-client';
import { setMlsSessionVacatedHandler } from '$lib/mls-client/mlsSessionVacancy';
import { TauriMlsService } from './TauriMlsService';

/**
 * WHAT A FAILED LOAD OF `mls.bin` DOES, NOW THAT A FRAMED STATE NAMES ITS KEY AND A RECORD BESIDE IT
 * NAMES ITS ACCOUNT (step 2 of the damaged-state P1, and the "switching accounts on one iPhone"
 * entry, 2026-10-17).
 *
 * Three answers, and each is the one its cause has earned:
 *  - `mls.owner` names ANOTHER account: refused, typed, nothing written - the gate withholds the
 *    reset that would delete that account's state;
 *  - the header names THIS key and the tag fails (`STATE_ALTERED`): no PIN opens it, so the device
 *    identity is rotated even under `noFreshStart` - DE7's route that needs no old PIN;
 *  - the header names another key (`STATE_KEY_MISMATCH`): paused for the old PIN, typed `rotated`.
 */
interface ServiceInternals {
  deviceId: string;
  rotateDeviceIdentity(deviceKeyB64: string, reason: string): Promise<string>;
  _initImpl(
    userId: string,
    deviceKeyB64: string,
    state?: Uint8Array,
    opts?: { noFreshStart?: boolean; stateOnDisk?: boolean; legacyPin?: string }
  ): Promise<void>;
}

const BOB = 'bob';
const KEY = 'k'.repeat(44);
const PAUSE_FOR_PIN = { noFreshStart: true, stateOnDisk: true, legacyPin: '1234' };

const ALTERED = 'STATE_ALTERED: v1 tag did not verify under the key its header names';
const ROTATED = "STATE_KEY_MISMATCH: the state's header names a different device key";

/** `initialiser_mls` refuses with `loadError`; `mls_state_owner` answers `owner`. */
function disk(loadError: string, owner: string | null): void {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'initialiser_mls') return Promise.reject(new Error(loadError));
    if (cmd === 'mls_state_owner') return Promise.resolve(owner);
    return Promise.resolve(undefined);
  });
}

function makeService(): { svc: ServiceInternals; rotate: ReturnType<typeof vi.spyOn> } {
  const svc = new TauriMlsService() as unknown as ServiceInternals;
  svc.deviceId = 'bob-device';
  const rotate = vi.spyOn(svc, 'rotateDeviceIdentity').mockResolvedValue('abandoned');
  return { svc, rotate };
}

const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd).length;

async function settle(run: Promise<void>): Promise<unknown> {
  return run.then(
    () => null,
    (e: unknown) => e
  );
}

describe("TauriMlsService init - another account's mls.bin, and a state no PIN opens", () => {
  beforeEach(() => {
    invoke.mockReset();
    localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it("refuses a state recorded as ANOTHER account's - nothing rotated, no legacy re-seal, nothing written", async () => {
    disk('STATE_UNDECRYPTABLE: aead::Error', 'alice');
    const { svc, rotate } = makeService();

    const err = await settle(svc._initImpl(BOB, KEY, undefined, PAUSE_FOR_PIN));

    expect(err).toBeInstanceOf(SavedStateOfAnotherAccountError);
    expect(rotate).not.toHaveBeenCalled();
    // ONE load: a second would be the legacy re-seal, which PERSISTS a rewritten mls.bin.
    expect(calls('initialiser_mls')).toBe(1);
    expect(calls('sauvegarder_mls_et_persister')).toBe(0);
  });

  it('refuses it whatever the cause - even an ALTERED one, which would otherwise rotate', async () => {
    // The record is the stronger fact: a rotation writes over the one mls.bin of the install.
    disk(ALTERED, 'alice');
    const { svc, rotate } = makeService();

    expect(await settle(svc._initImpl(BOB, KEY, undefined, PAUSE_FOR_PIN))).toBeInstanceOf(
      SavedStateOfAnotherAccountError
    );
    expect(rotate).not.toHaveBeenCalled();
  });

  it('CONTROL: a record naming THIS account, or none at all, is no proof - the ordinary pause', async () => {
    for (const owner of [BOB, null]) {
      invoke.mockReset();
      disk('STATE_UNDECRYPTABLE: aead::Error', owner);
      const { svc, rotate } = makeService();

      const err = await settle(svc._initImpl(BOB, KEY, undefined, PAUSE_FOR_PIN));

      expect(err, `owner=${owner}`).toBeInstanceOf(SavedStateUnopenedError);
      expect((err as SavedStateUnopenedError).reason).toBe('undecryptable');
      expect(rotate).not.toHaveBeenCalled();
    }
  });

  it('asks for no owner when the load succeeds - the record costs a sign-in nothing', async () => {
    invoke.mockResolvedValue(undefined);
    const { svc } = makeService();

    await svc._initImpl(BOB, KEY, undefined, PAUSE_FOR_PIN);

    expect(calls('mls_state_owner')).toBe(0);
  });

  it('rotates a state ALTERED under the key in hand even under noFreshStart (DE7, CORRUPT-2)', async () => {
    disk(ALTERED, BOB);
    const { svc, rotate } = makeService();

    await svc._initImpl(BOB, KEY, undefined, PAUSE_FOR_PIN);

    expect(rotate).toHaveBeenCalledTimes(1);
    expect(rotate.mock.calls[0][1]).toContain('altered');
    // A framed blob is never a pre-v0.11.0 envelope: no legacy retry before the rotation.
    expect(calls('initialiser_mls')).toBe(1);
  });

  it('pauses a state framed under ANOTHER key as `rotated` - the old PIN opens it, nothing rotated', async () => {
    disk(ROTATED, BOB);
    const { svc, rotate } = makeService();

    const err = await settle(svc._initImpl(BOB, KEY, undefined, PAUSE_FOR_PIN));

    expect(err).toBeInstanceOf(SavedStateUnopenedError);
    expect((err as SavedStateUnopenedError).reason).toBe('rotated');
    expect(rotate).not.toHaveBeenCalled();
    expect(calls('initialiser_mls')).toBe(1);
  });
});

/**
 * A FAILED INSTALL LEAVES NO SESSION BEHIND. The native slot is process-wide and was only ever
 * written on success, so account B's refused sign-in left account A's manager and key installed.
 * The native install guard empties it by construction; the service ends it through the one helper
 * too, before the refusal reaches the gate - and the install's own error is what propagates.
 */
describe('TauriMlsService init - a refused initialiser_mls ends the native session', () => {
  beforeEach(() => {
    invoke.mockReset();
    localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("ends it, keeping the state files, and rethrows the install's own error", async () => {
    disk('STATE_UNDECRYPTABLE: aead::Error', 'alice');
    const { svc } = makeService();

    const err = await settle(svc._initImpl(BOB, KEY, undefined, PAUSE_FOR_PIN));

    expect(err).toBeInstanceOf(SavedStateOfAnotherAccountError);
    const ends = invoke.mock.calls.filter((c) => c[0] === 'terminer_session_mls');
    expect(ends.length).toBeGreaterThanOrEqual(1);
    expect(ends[0][1]).toMatchObject({ reason: 'failed initialiser_mls', sweepState: false });
    // Ended BEFORE the gate reads whose state it is: nothing of the failed install is left to read it.
    const order = invoke.mock.calls.map((c) => c[0]);
    expect(order.indexOf('terminer_session_mls')).toBeLessThan(order.indexOf('mls_state_owner'));
  });
});

/**
 * A RESUME INTO AN EMPTY SLOT IS NOT A WARNING. With no native session under a signed-in one, every
 * later MLS command is refused while the screen looks alive - so the vacancy is reported (the shell
 * ends the session into the sign-in screen) and the resume sequence is told to stop, typed.
 */
describe('TauriMlsService resume - no native session under a signed-in one', () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => setMlsSessionVacatedHandler(null));

  it('reports the vacancy and rejects with MlsSessionVacantError', async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === 'recharger_mls_au_resume'
        ? Promise.reject(
            new Error('MLS_MANAGER_ABSENT: no MLS session is installed in this process')
          )
        : Promise.resolve(undefined)
    );
    const vacated = vi.fn();
    setMlsSessionVacatedHandler(vacated);
    const svc = new TauriMlsService() as unknown as {
      _deviceKeyB64: string;
      reloadStateFromDisk(): Promise<void>;
    };
    svc._deviceKeyB64 = KEY;

    await expect(svc.reloadStateFromDisk()).rejects.toBeInstanceOf(MlsSessionVacantError);
    expect(vacated).toHaveBeenCalledWith('resume found no native session');
  });

  it('any other reload failure is logged and the resume carries on, as before', async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === 'recharger_mls_au_resume'
        ? Promise.reject(new Error('reload mls.bin: aead::Error'))
        : Promise.resolve(undefined)
    );
    const vacated = vi.fn();
    setMlsSessionVacatedHandler(vacated);
    const svc = new TauriMlsService() as unknown as {
      _deviceKeyB64: string;
      reloadStateFromDisk(): Promise<void>;
    };
    svc._deviceKeyB64 = KEY;

    await expect(svc.reloadStateFromDisk()).resolves.toBeUndefined();
    expect(vacated).not.toHaveBeenCalled();
  });
});
