vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import {
  keyPackageWaitFields,
  publishedKeyPackageAnswer,
} from './BaseMlsService.keyPackageFixture';

/**
 * A device MINTED in this process whose FIRST KeyPackage round is running does not ask the server
 * whether the package exists: it cannot yet, so the GET could only answer 404. The read is made when
 * the round settles. A RETURNING device (`stateWasExpected`) always reads: its package may already be
 * published, whatever its boot round does.
 */
function makeCtx(stateWasExpected = false) {
  const fetchDeviceKeyPackage = vi.fn().mockResolvedValue(publishedKeyPackageAnswer());
  const ctx = {
    ...keyPackageWaitFields(),
    userId: 'u',
    deviceId: 'd',
    stateWasExpected,
    delivery: { fetchDeviceKeyPackage },
  };
  return { ctx, fetchDeviceKeyPackage };
}

const wait = (ctx: ReturnType<typeof makeCtx>['ctx']) =>
  (ctx.awaitOwnKeyPackagePublished as (short: string) => Promise<string>).call(ctx, 'abcd1234');

describe('awaitOwnKeyPackagePublished while the first publication runs', () => {
  it('a device minted in this process does not read the server before that round settles, then reads once', async () => {
    const { ctx, fetchDeviceKeyPackage } = makeCtx();
    ctx.keyPackageRoundsActive = 1;
    const pending = wait(ctx);
    await Promise.resolve();
    expect(fetchDeviceKeyPackage).not.toHaveBeenCalled();

    ctx.keyPackageRoundsActive = 0;
    ctx.keyPackageRoundsSettled = 1;
    ctx.keyPackageRoundWaiters.splice(0).forEach((resolve) => resolve(false));
    await expect(pending).resolves.toBe('published');
    expect(fetchDeviceKeyPackage).toHaveBeenCalledTimes(1);
  });

  it('a RETURNING device reads at once while its boot round runs, and is answered published', async () => {
    const { ctx, fetchDeviceKeyPackage } = makeCtx(true);
    ctx.keyPackageRoundsActive = 1;

    await expect(wait(ctx)).resolves.toBe('published');
    expect(fetchDeviceKeyPackage).toHaveBeenCalledTimes(1);
  });

  it('still reads at once when no round runs', async () => {
    const { ctx, fetchDeviceKeyPackage } = makeCtx();
    await expect(wait(ctx)).resolves.toBe('published');
    expect(fetchDeviceKeyPackage).toHaveBeenCalledTimes(1);
  });
});
