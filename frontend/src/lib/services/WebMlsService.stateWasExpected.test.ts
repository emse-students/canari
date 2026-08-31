/**
 * WHO SAYS WHETHER A MISSING MLS STATE IS A LOSS.
 *
 * The WASM warns when a device key arrives with no encrypted state beside it. On a first enrolment
 * that pair is the ordinary shape of a new device; on a returning one it means something lost a
 * snapshot. The constructor sees the same two arguments in both cases and cannot tell them apart,
 * so until 2026-08-31 it warned on every fresh client and the campaign harness carried a needle
 * forgiving the line per row - a warning nobody could act on, which is the shape of noise.
 *
 * The discriminator was never missing, only unshared: `resolveDeviceId` either FINDS this device's
 * id or MINTS one, and that is exactly the question. These tests pin it at each of its origins,
 * because every one of them is a place a later change could quietly start claiming the wrong thing.
 */
const loadAndInitWasm = vi.hoisted(() => vi.fn().mockResolvedValue({ tag: 'wasm-client' }));

vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));
vi.mock('$lib/mls-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAndInitWasm,
}));

import { WebMlsService } from './WebMlsService';

const USER = 'u';
const KEY = 'device-key-b64';

/**
 * The members the two methods under test actually touch, and no others: a new dependency then
 * surfaces as an explicit failure instead of passing on an undefined.
 */
function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    deviceId: '',
    delivery: { userId: '', deviceId: '' },
    client: null,
    stateWasExpected: false,
    restoreDeviceIdFromNative: vi.fn().mockResolvedValue(null),
    generateDeviceId: vi.fn().mockReturnValue('web-u-minted'),
    ...overrides,
  };
}

/** The real resolution, which is the thing being asserted about. */
const resolveDeviceId = (ctx: unknown): Promise<string> =>
  (
    WebMlsService.prototype as unknown as {
      resolveDeviceId(u: string): Promise<string>;
    }
  ).resolveDeviceId.call(ctx, USER);

/** The real WASM-facing load, so the flag is read exactly where production reads it. */
const loadStateWithKey = (ctx: unknown, state?: Uint8Array): Promise<void> =>
  (
    WebMlsService.prototype as unknown as {
      loadStateWithKey(k: string, s?: Uint8Array): Promise<void>;
    }
  ).loadStateWithKey.call(ctx, KEY, state);

describe('what the WASM is told about a missing state', () => {
  beforeEach(() => {
    loadAndInitWasm.mockClear();
    localStorage.clear();
  });

  it('says a state WAS expected when this device id was already stored', async () => {
    // The case the warning exists for: this device has booted before, so a snapshot should be here.
    localStorage.setItem(`mls_device_id_${USER}`, 'web-u-returning');
    const ctx = makeCtx();

    await resolveDeviceId(ctx);
    await loadStateWithKey(ctx);

    expect(loadAndInitWasm).toHaveBeenCalledWith(USER, 'web-u-returning', undefined, KEY, true);
  });

  it('says it was NOT expected when the id had to be minted', async () => {
    // A first enrolment. Nothing was lost, and this is the boot that used to warn on every device.
    const ctx = makeCtx();

    await resolveDeviceId(ctx);
    await loadStateWithKey(ctx);

    expect(loadAndInitWasm).toHaveBeenCalledWith(USER, 'web-u-minted', undefined, KEY, false);
  });

  it('counts a native restore as expected - that id belongs to a device that already enrolled', async () => {
    // The Tauri path taken when localStorage was evicted from under a live install. The id comes
    // back, so the device is not new, so an absent state there IS the loss the warning describes.
    const ctx = makeCtx({
      restoreDeviceIdFromNative: vi.fn().mockResolvedValue('web-u-native'),
    });

    await resolveDeviceId(ctx);
    await loadStateWithKey(ctx);

    expect(loadAndInitWasm).toHaveBeenCalledWith(USER, 'web-u-native', undefined, KEY, true);
  });

  it('stops expecting one once the identity is rotated', async () => {
    // Rotation abandons the old id and starts over at a fresh one, deliberately loading no state.
    // Carrying the previous answer over would make an intended fresh start report itself as a loss.
    localStorage.setItem(`mls_device_id_${USER}`, 'web-u-returning');
    const ctx = makeCtx({
      persistCheckpoint: vi.fn().mockResolvedValue(undefined),
      deleteDevice: vi.fn().mockResolvedValue(undefined),
      // The REAL load, placed on the context because `rotateDeviceIdentity` calls it through
      // `this` and a plain object has no prototype chain to find it on.
      loadStateWithKey: (WebMlsService.prototype as unknown as Record<string, unknown>)
        .loadStateWithKey,
    });

    await resolveDeviceId(ctx);
    expect(ctx.stateWasExpected).toBe(true);

    await (
      WebMlsService.prototype as unknown as {
        rotateDeviceIdentity(k: string, r: string): Promise<string>;
      }
    ).rotateDeviceIdentity.call(ctx, KEY, 'credential mismatch - stale state');

    expect(ctx.stateWasExpected).toBe(false);
    expect(loadAndInitWasm).toHaveBeenLastCalledWith(USER, 'web-u-minted', undefined, KEY, false);
  });

  it('always expects one on the reload path, which exists only to install a snapshot', async () => {
    // `reloadClientFromState` takes a non-optional state, so the pair the warning fires on cannot
    // occur - and `true` is what says so rather than inheriting whatever the instance last decided.
    const ctx = makeCtx({
      stateWasExpected: false,
      swapClientMonotonic: vi.fn().mockReturnValue(true),
      deviceId: 'web-u-returning',
    });
    const snapshot = new Uint8Array([1, 2, 3]);

    await (
      WebMlsService.prototype as unknown as {
        reloadClientFromState(s: Uint8Array, k: string): Promise<boolean>;
      }
    ).reloadClientFromState.call(ctx, snapshot, KEY);

    expect(loadAndInitWasm).toHaveBeenCalledWith(USER, 'web-u-returning', snapshot, KEY, true);
  });
});
