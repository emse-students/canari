import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeCommitHold,
  markCommitGranted,
  startCommitHoldTiming,
  timeCommitStep,
} from './commitHoldTiming';

describe('commitHoldTiming', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Drives the module's clock by hand: each read returns the next value. */
  function clock(...reads: number[]) {
    const spy = vi.spyOn(performance, 'now');
    for (const r of reads) spy.mockReturnValueOnce(r);
  }

  it('splits the wait for the mutex from the hold, and names the checkpoint and the request', async () => {
    clock(100, 900, 910, 1000, 1000, 1300);
    const t = startCommitHoldTiming(); // asked 100
    markCommitGranted(t); // granted 900
    t.attempts += 1;
    await timeCommitStep(t, 'checkpointMs', async () => 'ok'); // 910 -> 1000
    await timeCommitStep(t, 'requestMs', async () => 'ok'); // 1000 -> 1300
    expect(describeCommitHold(t, 1331)).toBe(
      'waited 800 ms for the MLS mutex, held 431 ms (checkpoint 90 ms, request 300 ms, 1 attempt)'
    );
  });

  it('a second grant mark keeps the first, and a throwing step is still timed', async () => {
    clock(0, 10, 20, 70);
    const t = startCommitHoldTiming();
    markCommitGranted(t);
    markCommitGranted(t);
    await expect(
      timeCommitStep(t, 'requestMs', async () => {
        throw new Error('no answer');
      })
    ).rejects.toThrow('no answer');
    t.attempts = 2;
    expect(describeCommitHold(t, 110)).toBe(
      'waited 10 ms for the MLS mutex, held 100 ms (checkpoint 0 ms, request 50 ms, 2 attempts)'
    );
  });
});
