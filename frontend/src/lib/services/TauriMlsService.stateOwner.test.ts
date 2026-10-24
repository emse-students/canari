// @vitest-environment happy-dom
// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));
vi.mock('$lib/stores/auth', () => ({ getToken: vi.fn().mockResolvedValue('') }));

import { SavedStateOfAnotherAccountError, SavedStateUnopenedError } from '$lib/mls-client';
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
