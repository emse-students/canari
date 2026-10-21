// Same import-cycle break as the other BaseMlsService specs (auth store -> composables ->
// mlsService -> subclasses -> BaseMlsService).
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import {
  BaseMlsService,
  MAX_REFUSED_ROTATION_RELOADS,
  REFUSED_ROTATION_RELOADS_KEY,
} from './BaseMlsService';
import { createMlsStatePersister } from '$lib/mls-client/mlsStatePersister';
import type { IMlsService } from '$lib/mls-client';
import { keyPackageWaitFields } from './BaseMlsService.keyPackageFixture';
import { DeviceRevokedError } from '$lib/mls-client/mlsDeliveryApi';
import { MlsStateWriteRefusedError } from '$lib/utils/hex';

/**
 * Guards the recovery from a server-side revocation.
 *
 * Deleting a device denylists its id for good, while `resolveDeviceId` deliberately hands the same
 * id back after a reinstall. The server used to accept that re-registration and then filter the
 * device out of its own list forever - registered, invisible and never invitable, with no error
 * anywhere. It now refuses, and the only cure is to become a new device.
 */
function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'u',
    deviceId: 'd-revoked',
    delivery: { userId: 'u', deviceId: 'd-revoked' },
    generateDeviceId: vi.fn().mockReturnValue('d-fresh'),
    loadStateWithKey: vi.fn().mockResolvedValue(undefined),
    persistCheckpoint: vi.fn().mockResolvedValue(undefined),
    deleteDevice: vi.fn().mockResolvedValue(undefined),
    endDocumentAfterRefusedRotation: vi.fn(),
    // Real rotation: the assertions below are about what it does.
    rotateDeviceIdentity: BaseMlsService.prototype['rotateDeviceIdentity'],
    ...keyPackageWaitFields(),
    ...overrides,
  };
}

const generateKeyPackage = (ctx: unknown): Promise<Uint8Array> =>
  (
    BaseMlsService.prototype as unknown as {
      generateKeyPackage(k: string): Promise<Uint8Array>;
    }
  ).generateKeyPackage.call(ctx, 'key-b64');

describe('BaseMlsService.generateKeyPackage on a revoked device', () => {
  beforeEach(() => localStorage.clear());

  it('re-enrols under a fresh id and publishes again', async () => {
    const published = new Uint8Array([9]);
    const impl = vi
      .fn()
      .mockRejectedValueOnce(new DeviceRevokedError('d-revoked'))
      .mockResolvedValueOnce(published);
    const ctx = makeCtx({ generateKeyPackageImpl: impl });

    await expect(generateKeyPackage(ctx)).resolves.toBe(published);

    expect(ctx.deviceId).toBe('d-fresh');
    expect(ctx.delivery.deviceId).toBe('d-fresh');
    // Persisted before anything else may fail: a new id in localStorage next to the old state is
    // what made the identity churn self-sustaining.
    expect(localStorage.getItem('mls_device_id_u')).toBe('d-fresh');
    expect(ctx.persistCheckpoint).toHaveBeenCalledWith();
    expect(ctx.deleteDevice).toHaveBeenCalledWith('u', 'd-revoked');
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it('retries exactly once - a second refusal is a server bug, not a rotation loop', async () => {
    const impl = vi.fn().mockRejectedValue(new DeviceRevokedError('d-revoked'));
    const ctx = makeCtx({ generateKeyPackageImpl: impl });

    await expect(generateKeyPackage(ctx)).rejects.toBeInstanceOf(DeviceRevokedError);
    expect(impl).toHaveBeenCalledTimes(2);
  });

  /**
   * THE ROUND'S CALLER LOGS AND CARRIES ON (`syncConnectionAfterWsOpen`), so a refused re-enrolment
   * that only rolled the ids back left the session RUNNING on a fresh, groupless client under the
   * revoked id: every later round rotated again, and once this tab's counter passed the other's the
   * fresh state was written next to the old stored id - the churn the rotation exists to prevent.
   * The document is ended instead, and nothing shared names the fresh identity.
   */
  it('ENDS the document, nothing shared moved, when the re-enrolment checkpoint is REFUSED', async () => {
    const impl = vi.fn().mockRejectedValue(new DeviceRevokedError('d-revoked'));
    const ctx = makeCtx({
      generateKeyPackageImpl: impl,
      persistCheckpoint: vi.fn().mockRejectedValue(new MlsStateWriteRefusedError('collision')),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(generateKeyPackage(ctx)).rejects.toBeInstanceOf(MlsStateWriteRefusedError);
    error.mockRestore();
    expect(ctx.endDocumentAfterRefusedRotation).toHaveBeenCalledTimes(1);
    // The ids in memory agree with the client in memory until the reload replaces both.
    expect(ctx.deviceId).toBe('d-fresh');
    expect(localStorage.getItem('mls_device_id_u')).toBeNull();
    expect(ctx.deleteDevice).not.toHaveBeenCalled();
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('does not end the document for a rotation that failed for any other reason', async () => {
    const impl = vi.fn().mockRejectedValue(new DeviceRevokedError('d-revoked'));
    const ctx = makeCtx({
      generateKeyPackageImpl: impl,
      persistCheckpoint: vi.fn().mockRejectedValue(new Error('quota exceeded')),
    });

    await expect(generateKeyPackage(ctx)).rejects.toThrow('quota exceeded');
    expect(ctx.endDocumentAfterRefusedRotation).not.toHaveBeenCalled();
  });

  /**
   * THE VERSION GUARD ORDERS BY COUNTER ALONE, so it cannot end this document on its own. Modelled
   * here exactly as `hex.ts` decides: a capture is tagged with this document's next version, and
   * stored only when it is above the stored one. Refused as a COLLISION, the very next capture is
   * one above and lands; refused STALE BY ONE, the next collides and the one after lands - each time
   * the fresh, groupless client over the other document's good state, next to the old stored id.
   */
  describe.each([
    ['collision', 10, 10],
    ['stale', 10, 9],
  ] as const)('after a rotation refused as %s', (outcome, storedByOther, ourFirstVersion) => {
    function guardedCtx() {
      let next = ourFirstVersion;
      const written: number[] = [];
      const writeCheckpoint = vi.fn(async () => {
        const v = next++;
        if (v === storedByOther) throw new MlsStateWriteRefusedError('collision');
        if (v < storedByOther) throw new MlsStateWriteRefusedError('stale');
        written.push(v);
      });
      const changeDeviceKeyImpl = vi.fn().mockResolvedValue(undefined);
      // The real seams: the latch is checked where every write of a live client passes.
      const seams = {
        persistCheckpoint: BaseMlsService.prototype.persistCheckpoint,
        changeDeviceKey: BaseMlsService.prototype.changeDeviceKey,
      };
      const ctx = makeCtx({
        generateKeyPackageImpl: vi.fn().mockRejectedValue(new DeviceRevokedError('d-revoked')),
        writeCheckpoint,
        changeDeviceKeyImpl,
        currentDeviceKeyB64: 'key-b64',
        ...seams,
      }) as ReturnType<typeof makeCtx> & typeof seams;
      return { ctx, written, writeCheckpoint, changeDeviceKeyImpl };
    }

    it('no later checkpoint, persister flight or re-seal of this document is ever written', async () => {
      const { ctx, written, writeCheckpoint, changeDeviceKeyImpl } = guardedCtx();
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(generateKeyPackage(ctx)).rejects.toMatchObject({ outcome });
      expect(ctx.endDocumentAfterRefusedRotation).toHaveBeenCalledTimes(1);

      // What runs between the reload and the unload: a watchdog's direct checkpoint, the
      // persister's flights (each failure re-raises its dirty flag, so it tries again), a re-seal.
      const persister = createMlsStatePersister({
        mlsService: ctx as unknown as IMlsService,
      });
      for (let i = 0; i < 3; i++) {
        await expect(ctx.persistCheckpoint()).rejects.toMatchObject({ outcome: 'ended' });
        persister.scheduleDeferred();
        await expect(persister.flushEncrypted()).rejects.toMatchObject({ outcome: 'ended' });
      }
      await expect(ctx.changeDeviceKey('new-key')).rejects.toMatchObject({ outcome: 'ended' });

      expect(written).toEqual([]);
      // Only the rotation's own capture ever reached the guard.
      expect(writeCheckpoint).toHaveBeenCalledTimes(1);
      expect(changeDeviceKeyImpl).not.toHaveBeenCalled();
      error.mockRestore();
      warn.mockRestore();
    });
  });

  describe('the reload a refused rotation costs is bounded per tab', () => {
    beforeEach(() => sessionStorage.clear());

    function endingCtx() {
      return {
        reloadDocument: vi.fn(),
        endDocumentAfterRefusedRotation:
          BaseMlsService.prototype['endDocumentAfterRefusedRotation'],
      };
    }

    it(`reloads ${MAX_REFUSED_ROTATION_RELOADS} times in a row, then stops and says so`, () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Each call is one page: a reload keeps `sessionStorage`, so the count carries across them.
      for (let page = 0; page < MAX_REFUSED_ROTATION_RELOADS + 2; page++) {
        const ctx = endingCtx();
        ctx.endDocumentAfterRefusedRotation();
        expect(ctx.reloadDocument).toHaveBeenCalledTimes(
          page < MAX_REFUSED_ROTATION_RELOADS ? 1 : 0
        );
      }
      expect(error).toHaveBeenCalledWith(expect.stringContaining('NOT reloaded again'));
      error.mockRestore();
      warn.mockRestore();
    });

    it('a rotation that lands resets the count', async () => {
      sessionStorage.setItem(REFUSED_ROTATION_RELOADS_KEY, String(MAX_REFUSED_ROTATION_RELOADS));
      const ctx = makeCtx({
        generateKeyPackageImpl: vi
          .fn()
          .mockRejectedValueOnce(new DeviceRevokedError('d-revoked'))
          .mockResolvedValueOnce(new Uint8Array([1])),
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await generateKeyPackage(ctx);
      warn.mockRestore();
      expect(sessionStorage.getItem(REFUSED_ROTATION_RELOADS_KEY)).toBeNull();
    });
  });

  it('leaves any other failure alone, identity untouched', async () => {
    const impl = vi.fn().mockRejectedValue(new Error('network down'));
    const ctx = makeCtx({ generateKeyPackageImpl: impl });

    await expect(generateKeyPackage(ctx)).rejects.toThrow('network down');
    expect(ctx.deviceId).toBe('d-revoked');
    expect(ctx.generateDeviceId).not.toHaveBeenCalled();
    expect(ctx.deleteDevice).not.toHaveBeenCalled();
    expect(impl).toHaveBeenCalledTimes(1);
  });
});
