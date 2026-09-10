import { forEachBounded, PUSH_FAN_OUT_LIMIT } from './fan-out';

/**
 * What a bound is for: the WIDTH, and the fact that every item still runs.
 *
 * The defect this prevents is not a wrong result - `Promise.all` returns the right thing. It is
 * 356 sockets opened at once by one cron tick, which the delivery service answers by refusing
 * everything for the duration, messages included. So the property under test is peak concurrency,
 * and it can only be observed by watching tasks overlap.
 */
describe('forEachBounded', () => {
  /** Runs `n` tasks that each resolve on the next tick, recording how many were ever in flight. */
  async function runAndWatch(n: number, limit: number) {
    const items = Array.from({ length: n }, (_, i) => i);
    const done: number[] = [];
    let inFlight = 0;
    let peak = 0;
    await forEachBounded(items, limit, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      done.push(i);
    });
    return { done, peak };
  }

  it('never runs more than the limit at once', async () => {
    const { peak } = await runAndWatch(50, 4);
    expect(peak).toBe(4);
  });

  it('runs every item exactly once, and resolves only when all have finished', async () => {
    const { done } = await runAndWatch(50, 4);
    expect(done.sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it('opens no more workers than there are items', async () => {
    // Otherwise a two-recipient push would spin up sixteen workers to find nothing to do.
    const { peak } = await runAndWatch(2, 16);
    expect(peak).toBe(2);
  });

  it('does nothing at all for an empty list', async () => {
    const task = jest.fn();
    await forEachBounded([], 4, task);
    expect(task).not.toHaveBeenCalled();
  });

  it('keeps going after a task rejects, rather than abandoning the rest', async () => {
    // The failure that matters is not the one task that threw, it is the recipients queued behind
    // it. A worker pool that lets a rejection escape drops all of them.
    const seen: number[] = [];
    const failures = await forEachBounded([0, 1, 2, 3], 2, async (i) => {
      seen.push(i);
      if (i === 1) throw new Error('boom');
    });
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(failures.map((f) => f.item)).toEqual([1]);
  });

  it('hands every failure back rather than swallowing it', async () => {
    // Only the caller can name the item in a log, so a caught error that is not returned is a
    // loss with no trace - which in a best-effort path is the whole of the damage.
    const failures = await forEachBounded([0, 1, 2], 2, async (i) => {
      throw new Error(`boom ${i}`);
    });
    expect(failures).toHaveLength(3);
    expect(failures.map((f) => String(f.error)).sort()).toEqual([
      'Error: boom 0',
      'Error: boom 1',
      'Error: boom 2',
    ]);
  });

  it('returns nothing to report when every task succeeds', async () => {
    expect(await forEachBounded([1, 2, 3], 2, async () => {})).toEqual([]);
  });

  it('states a limit small enough to be a bound and large enough to be a fan-out', () => {
    expect(PUSH_FAN_OUT_LIMIT).toBeGreaterThan(1);
    expect(PUSH_FAN_OUT_LIMIT).toBeLessThan(64);
  });
});
