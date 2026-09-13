/**
 * A DEVICE'S IDENTITY SURVIVED ONLY A SUCCESSFUL NETWORK CALL.
 *
 * `deviceId` is not a preference. The MLS credential is `userId:deviceId`, so losing it does not
 * degrade a feature - it makes the client a DIFFERENT device, orphaning the leaf it holds in every
 * group's ratchet tree and forcing a re-enrolment that no peer asked for.
 *
 * It lives in `localStorage`, which an Android WebView evicts under pressure and a reinstall
 * clears. Its ONLY durable copy was `push_context.json`, and nothing wrote that file for the sake
 * of identity: it was written exclusively by `store_push_context`, which on the JS side sat inside
 * `getToken().then(...)` - an auth-token refresh, a NETWORK round-trip - was skipped entirely when
 * no device key was available (biometric mode), and on the Rust side returned `Err` BEFORE the
 * write if the platform keystore refused. Every one of those failures was swallowed without a log.
 *
 * So three things that have nothing to do with identity each silently minted a new device.
 * Production, 2026-09-12: 138 of 361 accounts carry ONE device name under several `deviceId`s -
 * 40% of iOS accounts, 38% of Android, against 12% Windows and 9% macOS. The gap is mobile, and
 * mobile is exactly where the WebView eviction happens.
 *
 * WHAT IS ASSERTED HERE is that the mirror is now a step of resolution itself, taken from the one
 * place that knows the id, with no precondition: no token, no device key, no keystore. It runs on
 * every resolution and not only on a mint, because that is what repairs the estate already
 * affected - a device whose id is in `localStorage` but whose file was never written is one
 * eviction away from the same loss, and its next sign-in is the only chance to fix it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseMlsService } from '$lib/services/BaseMlsService';

/** @see BaseMlsService.unresolvedIdentity.test.ts - same reason the cast is what instantiates the base. */
abstract class Harness extends BaseMlsService {}

const makeService = (): BaseMlsService =>
  new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)('web');

const poke = (svc: BaseMlsService, patch: Record<string, unknown>): void => {
  Object.assign(svc, patch);
};

/** The native mirror, installed over the protected hook the way a platform subclass overrides it. */
const withMirror = (svc: BaseMlsService, mirror: unknown): void =>
  poke(svc, { persistDeviceIdNatively: mirror });

const KEY = 'mls_device_id_u-1';

describe('the durable copy of a device identity', () => {
  let svc: BaseMlsService;
  let mirror: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    svc = makeService();
    mirror = vi.fn().mockResolvedValue(undefined);
    withMirror(svc, mirror);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('mirrors a freshly minted id, so the very first eviction cannot orphan it', async () => {
    const id = await svc.resolveDeviceId('u-1');

    expect(id).toBeTruthy();
    expect(mirror).toHaveBeenCalledWith('u-1', id);
  });

  it('mirrors an id read back from localStorage - that is what repairs an existing device', async () => {
    localStorage.setItem(KEY, 'd-already-enrolled');

    const id = await svc.resolveDeviceId('u-1');

    expect(id).toBe('d-already-enrolled');
    // The id was never lost here, so nothing LOOKS broken - and that is exactly the device whose
    // file was never written, one WebView eviction away from becoming a second device.
    expect(mirror).toHaveBeenCalledWith('u-1', 'd-already-enrolled');
  });

  it('mirrors an id recovered from the native side, closing the loop after an eviction', async () => {
    poke(svc, { restoreDeviceIdFromNative: vi.fn().mockResolvedValue('d-restored') });

    const id = await svc.resolveDeviceId('u-1');

    expect(id).toBe('d-restored');
    expect(localStorage.getItem(KEY)).toBe('d-restored');
    expect(mirror).toHaveBeenCalledWith('u-1', 'd-restored');
  });

  it('mirrors with no device key and no token in hand - neither is an argument of resolution', async () => {
    // The regression was a coupling, so the assertion is the ABSENCE of one: resolveDeviceId is
    // reached before any key is derived and before any request is made, and the mirror runs there.
    await svc.resolveDeviceId('u-1');

    expect(mirror).toHaveBeenCalledTimes(1);
    expect(svc.resolveDeviceId.length).toBe(1);
  });

  it('still resolves when the mirror fails, and ACCUSES rather than swallowing it', async () => {
    const complaint = vi.spyOn(console, 'error').mockImplementation(() => {});
    withMirror(
      svc,
      vi.fn().mockImplementation(() => {
        throw new Error('app_data_dir unavailable');
      })
    );

    // Availability first: a device that cannot write its backup must still be able to sign in.
    const id = await svc.resolveDeviceId('u-1');
    expect(id).toBeTruthy();

    // A best-effort path that logs nothing leaves nothing behind, and this one is the reason the
    // estate drifted unnoticed for months.
    expect(complaint).toHaveBeenCalledWith(
      expect.stringContaining('[IDENTITY]'),
      expect.anything()
    );
  });

  it('mirrors once per resolution, not once per caller - the second call is already resolved', async () => {
    await svc.resolveDeviceId('u-1');
    await svc.resolveDeviceId('u-1');

    expect(mirror).toHaveBeenCalledTimes(1);
  });
});
