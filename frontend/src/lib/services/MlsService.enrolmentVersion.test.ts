// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) the same way `TauriMlsService.resumeReload.test.ts` does.
vi.mock('$lib/services/WebMlsService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));
vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));

import { TauriMlsService } from './TauriMlsService';
import { WebMlsService } from './WebMlsService';
import { getClientAppVersion } from '$lib/utils/appVersion';

/**
 * EVERY DEVICE STATES ITS VERSION WHEN IT ENROLS, AND FOR TWO THIRDS OF THE FLEET NONE DID.
 *
 * `key_package.deviceAppVersion` is the only table recording what build a device runs, and
 * `minClientVersion` - the single control that can lock a user out of the app - is raised by hand
 * against it. Measured on production 2026-09-14, of the mobile devices that had enrolled in the
 * previous 30 days: 168 of 226 iPhones and 87 of 170 Android devices carried NO version, and every
 * one of the 134 desktop browsers carried none either. A floor raised on that column was a decision
 * taken against two thirds of nothing.
 *
 * TWO CAUSES, ONE SHAPE. The web service never sent the field at all. The native one asked
 * `getVersion()` from `@tauri-apps/api/app` at runtime, which answers empty on iOS - so the
 * platform with the largest gap was the one that looked like it was reporting. Both are the same
 * mistake: a version is a BUILD-TIME fact, and the app embeds this very bundle, so the bundle's own
 * constant is the answer on every platform and no round trip can fail.
 *
 * These tests pin the field at both origins, because a version that goes missing is invisible -
 * the enrolment still succeeds, and the column simply stays empty until somebody counts it.
 */

/** The members `publishKeyPackage` actually touches, and no others. */
function ctx(register: ReturnType<typeof vi.fn>) {
  return {
    userId: 'u1',
    deviceId: 'd1',
    delivery: { registerDeviceKeyPackage: register },
  };
}

const KEY_PACKAGE = { bytes: new Uint8Array([1, 2, 3]), notAfterSecs: 1_800_000_000 };

describe('publishKeyPackage - the version a device enrols with', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('sends the build-time version from the WEB service, which used to send nothing', async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    await WebMlsService.prototype.publishKeyPackage.call(ctx(register), KEY_PACKAGE);

    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0][0]).toMatchObject({
      deviceAppVersion: getClientAppVersion(),
    });
  });

  it('sends the build-time version from the NATIVE service, with no runtime call to make', async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    await TauriMlsService.prototype.publishKeyPackage.call(ctx(register), KEY_PACKAGE);

    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0][0]).toMatchObject({
      deviceAppVersion: getClientAppVersion(),
    });
  });

  it('states the SAME version on both, which is what makes the column comparable at all', async () => {
    const web = vi.fn().mockResolvedValue(undefined);
    const native = vi.fn().mockResolvedValue(undefined);
    await WebMlsService.prototype.publishKeyPackage.call(ctx(web), KEY_PACKAGE);
    await TauriMlsService.prototype.publishKeyPackage.call(ctx(native), KEY_PACKAGE);

    const webVersion = (web.mock.calls[0][0] as { deviceAppVersion?: string }).deviceAppVersion;
    const nativeVersion = (native.mock.calls[0][0] as { deviceAppVersion?: string })
      .deviceAppVersion;
    expect(webVersion).toBe(nativeVersion);
  });

  it('never omits the field, whatever the version turns out to be', async () => {
    // `0.0.0` is not a placeholder for `unknown` here: it is exactly what the version gate would
    // compare, so a row carrying it is a device any floor blocks - a fact, not a gap.
    const register = vi.fn().mockResolvedValue(undefined);
    await TauriMlsService.prototype.publishKeyPackage.call(ctx(register), KEY_PACKAGE);

    const sent = register.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.hasOwn(sent, 'deviceAppVersion')).toBe(true);
    expect(sent.deviceAppVersion).toBeTruthy();
  });
});

/**
 * The other column a registration writes that nobody could see before.
 *
 * `notAfter` is the instant the published package stops being usable, and until 2026-09-16 the
 * delivery service had no way to learn it: it stores an opaque base64 string and cannot parse an
 * MLS KeyPackage. Measured on production that day, it served a last-resort package 48 hours past
 * its `not_after` and the join failed for ever. Pinned on BOTH services for the same reason the
 * version above is: a field one platform omits is a column that answers for half the estate.
 */
describe('publishKeyPackage - the expiry a device enrols with', () => {
  it('sends it from the WEB service, as an ISO instant derived from the package itself', async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    await WebMlsService.prototype.publishKeyPackage.call(ctx(register), KEY_PACKAGE);

    expect(register.mock.calls[0][0]).toMatchObject({
      notAfterSecs: KEY_PACKAGE.notAfterSecs,
    });
  });

  it('sends it from the NATIVE service too', async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    await TauriMlsService.prototype.publishKeyPackage.call(ctx(register), KEY_PACKAGE);

    expect(register.mock.calls[0][0]).toMatchObject({
      notAfterSecs: KEY_PACKAGE.notAfterSecs,
    });
  });
});
