vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import {
  keyPackageWaitFields,
  publishedKeyPackageAnswer,
} from './BaseMlsService.keyPackageFixture';

/**
 * A client whose FIRST KeyPackage round is running does not ask the server whether the package
 * exists: it cannot yet, so the GET could only answer 404. The read is made when the round settles.
 */
function makeCtx() {
  const fetchDeviceKeyPackage = vi.fn().mockResolvedValue(publishedKeyPackageAnswer());
  const ctx = {
    ...keyPackageWaitFields(),
    userId: 'u',
    deviceId: 'd',
    delivery: { fetchDeviceKeyPackage },
  };
  return { ctx, fetchDeviceKeyPackage };
}

const wait = (ctx: ReturnType<typeof makeCtx>['ctx']) =>
  (ctx.awaitOwnKeyPackagePublished as (short: string) => Promise<string>).call(ctx, 'abcd1234');

describe('awaitOwnKeyPackagePublished while the first publication runs', () => {
  it('does not read the server before that round settles, then reads once', async () => {
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

  it('still reads at once when no round runs', async () => {
    const { ctx, fetchDeviceKeyPackage } = makeCtx();
    await expect(wait(ctx)).resolves.toBe('published');
    expect(fetchDeviceKeyPackage).toHaveBeenCalledTimes(1);
  });
});
