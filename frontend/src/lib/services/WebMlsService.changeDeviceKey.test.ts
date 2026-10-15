/**
 * The device key change's MLS write MUST land. The version guard drops a capture that is not newer
 * than the stored one - a follower tab's client, loaded from an older snapshot than the leader last
 * wrote, always is - and a dropped re-seal left the stored state under the OLD key while the change
 * logged "done".
 */
const saveMlsState = vi.hoisted(() => vi.fn());

vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));
vi.mock('$lib/mls-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAndInitWasm: vi.fn(),
}));
vi.mock('$lib/utils/hex', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveMlsState,
}));

import { MlsStateWriteRefusedError } from '$lib/utils/hex';
import { WebMlsService } from './WebMlsService';

function changeDeviceKeyImpl(key: string): Promise<void> {
  const ctx = { userId: 'u1', saveState: vi.fn().mockResolvedValue(new Uint8Array([7])) };
  return (
    WebMlsService.prototype['changeDeviceKeyImpl'] as (this: unknown, k: string) => Promise<void>
  ).call(ctx, key);
}

describe('WebMlsService.changeDeviceKeyImpl', () => {
  it('resolves when the re-sealed state is written', async () => {
    saveMlsState.mockResolvedValueOnce('written');
    await expect(changeDeviceKeyImpl('k')).resolves.toBeUndefined();
  });

  it.each(['stale', 'collision'] as const)(
    'FAILS, typed, when the version guard drops the write (%s)',
    async (outcome) => {
      saveMlsState.mockResolvedValueOnce(outcome);
      const failure = await changeDeviceKeyImpl('k').catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(MlsStateWriteRefusedError);
      expect((failure as MlsStateWriteRefusedError).outcome).toBe(outcome);
    }
  );
});
