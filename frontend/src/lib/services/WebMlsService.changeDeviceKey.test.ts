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

  // `superseded` too: the re-seal must land ITSELF, and a newer blob of this document may still be
  // sealed under the old key.
  it.each(['superseded', 'stale', 'collision', 'ended'] as const)(
    'FAILS, typed, when the version guard drops the write (%s)',
    async (outcome) => {
      saveMlsState.mockResolvedValueOnce(outcome);
      const failure = await changeDeviceKeyImpl('k').catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(MlsStateWriteRefusedError);
      expect((failure as MlsStateWriteRefusedError).outcome).toBe(outcome);
    }
  );

  // An ENDED document was said once, by the refused rotation; a re-seal it refuses is silent, while
  // a guard refusal still names its outcome.
  it.each([
    ['ended', 0],
    ['stale', 1],
  ] as const)('a re-seal refused as %s logs %i error line(s)', async (outcome, lines) => {
    saveMlsState.mockResolvedValueOnce(outcome);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await changeDeviceKeyImpl('k').catch(() => {});
    expect(error).toHaveBeenCalledTimes(lines);
    error.mockRestore();
  });
});

/**
 * A CHECKPOINT THAT RESOLVES IS A CHECKPOINT ON DISK. Every waiter of `persistCheckpoint` - the send
 * ledger, the history marks, `externalJoin` - reads a resolution as "this state is durable"; a write
 * the guard dropped used to resolve all the same.
 */
describe('WebMlsService.writeCheckpoint', () => {
  function writeCheckpoint(): Promise<void> {
    const ctx = { userId: 'u1', saveState: vi.fn().mockResolvedValue(new Uint8Array([7])) };
    return (
      WebMlsService.prototype['writeCheckpoint'] as (this: unknown, k: string) => Promise<void>
    ).call(ctx, 'k');
  }

  it.each(['written', 'superseded'] as const)(
    'resolves, silently, when the state is on disk (%s)',
    async (outcome) => {
      saveMlsState.mockResolvedValueOnce(outcome);
      const warn = vi.spyOn(console, 'warn');
      await expect(writeCheckpoint()).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    }
  );

  it('hands the latch to the write, read at its put after this capture and its seal', async () => {
    saveMlsState.mockResolvedValueOnce('written');
    const latch = { isEnded: () => false };
    const ctx = { userId: 'u1', saveState: vi.fn().mockResolvedValue(new Uint8Array([7])) };
    await (
      WebMlsService.prototype['writeCheckpoint'] as (
        this: unknown,
        k: string,
        l: typeof latch
      ) => Promise<void>
    ).call(ctx, 'k', latch);
    expect(saveMlsState).toHaveBeenLastCalledWith('u1', new Uint8Array([7]), latch);
  });

  it.each(['stale', 'collision', 'ended'] as const)(
    'REJECTS, typed and silently, when the state is not on disk (%s)',
    async (outcome) => {
      saveMlsState.mockResolvedValueOnce(outcome);
      const warn = vi.spyOn(console, 'warn');
      const failure = await writeCheckpoint().catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(MlsStateWriteRefusedError);
      expect((failure as MlsStateWriteRefusedError).outcome).toBe(outcome);
      // The guard said it, once; this layer only carries the type.
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    }
  );
});
