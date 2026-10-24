// @vitest-environment happy-dom
/**
 * A DEVICE THAT KEPT ITS ID BUT LOST ITS STATE IS A NEW DEVICE (lead decision, 2026-10-22).
 *
 * Its old signature key went with the state, so peers that pinned it refuse to re-add it under the
 * old name. At start-up it rotates to a new id and retires the old one - and ONLY when the state is
 * PROVABLY absent: a present state that will not open (a PIN problem, a locked keystore) and an
 * absence nobody could prove both leave the identity alone.
 *
 * The real `_initImpl`, `resolveDeviceId`, `reenrolLostState` and `rotateDeviceIdentity` run here;
 * only the WASM load, the disk and the network are stubbed.
 */
const loadAndInitWasm = vi.hoisted(() => vi.fn().mockResolvedValue({ tag: 'wasm-client' }));

vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));
vi.mock('$lib/mls-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAndInitWasm,
}));

import { WebMlsService } from './WebMlsService';
import { SavedStateUnopenedError } from '$lib/mls-client/IMlsService';
import { readAbandonedDeviceIds, retireAbandonedDevices } from '$lib/mls-client/abandonedDevices';

const USER = 'u';
const KEY = 'device-key-b64';
const proto = WebMlsService.prototype as unknown as Record<string, unknown>;

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    deviceId: '',
    delivery: { userId: '', deviceId: '' },
    client: null,
    owedSendBurns: new Map(),
    unprovenSendRatchets: new Set(),
    owedBurnInFlight: new Map(),
    stateWasExpected: false,
    restoreDeviceIdFromNative: vi.fn().mockResolvedValue(null),
    persistDeviceIdNatively: vi.fn().mockResolvedValue(undefined),
    generateDeviceId: vi.fn().mockReturnValue('web-u-new'),
    persistCheckpoint: vi.fn().mockResolvedValue(undefined),
    deleteDevice: vi.fn().mockResolvedValue({ status: 'deleted' }),
    savedStateProvenAbsent: vi.fn().mockResolvedValue(true),
    classifyStateLoadFailure: vi.fn().mockReturnValue('undecryptable'),
    // The real members the path under test reaches through `this`.
    resolveDeviceId: proto.resolveDeviceId,
    reenrolLostState: proto.reenrolLostState,
    rotateDeviceIdentity: proto.rotateDeviceIdentity,
    loadStateWithKey: proto.loadStateWithKey,
    ...overrides,
  };
}

const init = (ctx: unknown, state?: Uint8Array, opts?: Record<string, unknown>) =>
  (
    proto._initImpl as (
      u: string,
      k: string,
      s?: Uint8Array,
      o?: Record<string, unknown>
    ) => Promise<void>
  ).call(ctx, USER, KEY, state, opts);

describe('WebMlsService - a kept id with a lost state re-enrols as a new device', () => {
  beforeEach(() => {
    loadAndInitWasm.mockReset().mockResolvedValue({ tag: 'wasm-client' });
    localStorage.clear();
  });

  it('rotates to a new id and retires the old one exactly once', async () => {
    localStorage.setItem(`mls_device_id_${USER}`, 'web-u-old');
    const ctx = makeCtx();

    await init(ctx);
    // The retirement is started, not awaited, by the rotation: join its flight.
    await retireAbandonedDevices({
      userId: USER,
      liveDeviceId: ctx.deviceId,
      deleteDevice: ctx.deleteDevice,
    });

    expect(ctx.deviceId).toBe('web-u-new');
    expect(localStorage.getItem(`mls_device_id_${USER}`)).toBe('web-u-new');
    expect(ctx.persistCheckpoint).toHaveBeenCalledTimes(1);
    expect(ctx.deleteDevice).toHaveBeenCalledTimes(1);
    expect(ctx.deleteDevice).toHaveBeenCalledWith(USER, 'web-u-old');
    expect(readAbandonedDeviceIds(USER)).toEqual([]);

    // A later round finds nothing left to retire.
    await retireAbandonedDevices({
      userId: USER,
      liveDeviceId: ctx.deviceId,
      deleteDevice: ctx.deleteDevice,
    });
    expect(ctx.deleteDevice).toHaveBeenCalledTimes(1);
  });

  it('never rotates a present state that does not open - a PIN problem stays a PIN problem', async () => {
    localStorage.setItem(`mls_device_id_${USER}`, 'web-u-old');
    loadAndInitWasm.mockRejectedValue(new Error('aead::Error'));
    const ctx = makeCtx();

    await expect(
      init(ctx, new Uint8Array([1, 2, 3]), { noFreshStart: true })
    ).rejects.toBeInstanceOf(SavedStateUnopenedError);

    expect(ctx.savedStateProvenAbsent).not.toHaveBeenCalled();
    expect(ctx.deviceId).toBe('web-u-old');
    expect(ctx.deleteDevice).not.toHaveBeenCalled();
    expect(readAbandonedDeviceIds(USER)).toEqual([]);
  });

  it('does not rotate on an absence the store could not prove', async () => {
    localStorage.setItem(`mls_device_id_${USER}`, 'web-u-old');
    const ctx = makeCtx({ savedStateProvenAbsent: vi.fn().mockRejectedValue(new Error('idb')) });

    await init(ctx);

    expect(ctx.deviceId).toBe('web-u-old');
    expect(ctx.deleteDevice).not.toHaveBeenCalled();
    expect(loadAndInitWasm).toHaveBeenCalledWith(USER, 'web-u-old', undefined, KEY, true);
  });

  it('does not rotate a first enrolment, whose id was just minted', async () => {
    const ctx = makeCtx({ generateDeviceId: vi.fn().mockReturnValue('web-u-first') });

    await init(ctx);

    expect(ctx.savedStateProvenAbsent).not.toHaveBeenCalled();
    expect(ctx.deviceId).toBe('web-u-first');
    expect(ctx.deleteDevice).not.toHaveBeenCalled();
  });
});
