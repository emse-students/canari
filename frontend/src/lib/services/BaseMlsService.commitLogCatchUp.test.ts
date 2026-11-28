/**
 * `catchUpFromCommitLog` - rung 1 for a call's group known behind (calls.md, "The answer joins on
 * its own group"). Its failure is CLASSIFIED AT THE THROW, by type: only a request that got no
 * answer is `unreachable` and takes back the epoch-gap mark it set; a server's refusal or a local
 * fault is `still-behind`, the mark kept for rung 2.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const replayAndRecord = vi.fn();
vi.mock('$lib/utils/chat/commitReplay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/commitReplay')>()),
  replayAndRecord: (...args: unknown[]) => replayAndRecord(...args),
}));

const { BaseMlsService } = await import('$lib/services/BaseMlsService');
const { isInEpochGap, markEpochGap, resetEpochGapRegistry } =
  await import('$lib/utils/chat/epochGapRegistry');
const { TransportFailureError } = await import('$lib/utils/transportFailure');
const { refusalFromResponse } = await import('$lib/utils/apiRefusalError');

/** @see BaseMlsService.deliveryIdentity.test.ts - same reason the cast is what instantiates the base. */
abstract class Harness extends BaseMlsService {
  protected override pausePlatformSocket(): void {}
}

/** A service whose MLS lock runs its section at once, the group at epoch 2. */
function service() {
  const svc = new (Harness as unknown as new (
    platform: 'web' | 'tauri'
  ) => InstanceType<typeof BaseMlsService>)('web');
  Object.assign(svc, {
    messageScheduler: { runUnderMlsLock: <T>(fn: () => Promise<T>) => fn() },
    getEpoch: () => 2,
  });
  return svc;
}

describe('catchUpFromCommitLog - its failures classified by type', () => {
  beforeEach(() => {
    resetEpochGapRegistry();
    replayAndRecord.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('a request that got NO ANSWER is unreachable, and the mark it set is taken back', async () => {
    replayAndRecord.mockRejectedValue(new TransportFailureError(new TypeError('Failed to fetch')));
    await expect(service().catchUpFromCommitLog('group-1')).resolves.toBe('unreachable');
    expect(isInEpochGap('group-1')).toBe(false);
  });

  it('a mark ANOTHER path set stays when the log got no answer', async () => {
    markEpochGap('group-1');
    replayAndRecord.mockRejectedValue(new TransportFailureError(new TypeError('Failed to fetch')));
    await expect(service().catchUpFromCommitLog('group-1')).resolves.toBe('unreachable');
    expect(isInEpochGap('group-1')).toBe(true);
  });

  it("the server's REFUSAL (a 403) is an answer: still behind, the mark kept for rung 2", async () => {
    const refusal = await refusalFromResponse(
      new Response(JSON.stringify({ code: 'forbidden' }), { status: 403 }),
      'Commit replay HTTP error'
    );
    replayAndRecord.mockRejectedValue(refusal);
    await expect(service().catchUpFromCommitLog('group-1')).resolves.toBe('still-behind');
    expect(isInEpochGap('group-1')).toBe(true);
    expect(console.error).toHaveBeenCalled();
  });

  it('a LOCAL fault (a commit that would not merge, a log that would not parse) is still behind, the mark kept', async () => {
    replayAndRecord.mockRejectedValue(new SyntaxError('Unexpected token < in JSON'));
    await expect(service().catchUpFromCommitLog('group-1')).resolves.toBe('still-behind');
    expect(isInEpochGap('group-1')).toBe(true);
  });

  it('a replay that heals says healed', async () => {
    replayAndRecord.mockResolvedValue({ healed: true, belowFloor: false, applied: 1 });
    await expect(service().catchUpFromCommitLog('group-1')).resolves.toBe('healed');
  });
});
