/**
 * The one bounded fan-out (weak-network audit, 2026-11-10): N independent reads cost ceil(N / limit)
 * round trips instead of N, never more than `limit` at once, and EVERY item runs whatever another
 * one did. Every test releases the work BY HAND, so nothing here reads a clock.
 */
import { describe, expect, it } from 'vitest';
import { forEachBounded } from './boundedConcurrency';

/** A work function whose calls stay pending until released; `inFlight` counts the unreleased. */
function heldWork() {
  const started: number[] = [];
  const release = new Map<number, (e?: Error) => void>();
  let inFlight = 0;
  let peak = 0;
  const work = (item: number) =>
    new Promise<void>((resolve, reject) => {
      started.push(item);
      inFlight++;
      peak = Math.max(peak, inFlight);
      release.set(item, (e) => {
        inFlight--;
        if (e) reject(e);
        else resolve();
      });
    });
  return {
    started,
    release,
    work,
    inFlight: () => inFlight,
    peak: () => peak,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const name = (item: number) => `item-${item}`;

describe('forEachBounded', () => {
  it('starts `limit` items at once, in order, and never holds more than `limit` after a release', async () => {
    const held = heldWork();
    const done = forEachBounded([1, 2, 3, 4, 5, 6, 7], 3, held.work, name);
    await flush();
    expect(held.started).toEqual([1, 2, 3]);
    expect(held.inFlight()).toBe(3);

    // Released out of order: each release lets exactly one more start, the next in line.
    for (const item of [2, 1, 4, 3, 5, 7, 6]) {
      held.release.get(item)?.();
      await flush();
      expect(held.inFlight()).toBeLessThanOrEqual(3);
    }
    await expect(done).resolves.toEqual([]);
    expect(held.started).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(held.peak()).toBe(3);
  });

  it('takes every item exactly once, a falsy one included', async () => {
    const seen: number[] = [];
    await forEachBounded(
      [0, 1, 0],
      2,
      async (item) => {
        seen.push(item);
      },
      name
    );
    expect(seen).toEqual([0, 1, 0]);
  });

  it('settles at once on an empty list', async () => {
    await expect(
      forEachBounded([], 6, () => Promise.reject(new Error('never')), name)
    ).resolves.toEqual([]);
  });

  it('runs every item when item 2 of 5 throws, and returns that failure', async () => {
    const held = heldWork();
    const done = forEachBounded([1, 2, 3, 4, 5], 2, held.work, name);
    await flush();
    expect(held.started).toEqual([1, 2]);

    const refused = new Error('refused');
    held.release.get(2)?.(refused);
    await flush();
    // The failure freed a slot, and the next item took it.
    expect(held.started).toEqual([1, 2, 3]);

    for (const item of [1, 3, 4, 5]) {
      held.release.get(item)?.();
      await flush();
    }
    await expect(done).resolves.toEqual([{ item: 2, error: refused }]);
    expect(held.started).toEqual([1, 2, 3, 4, 5]);
  });

  it('settles only once every item has: nothing still runs after it resolves', async () => {
    const held = heldWork();
    let settled = false;
    const done = forEachBounded([1, 2, 3], 3, held.work, name).then((failures) => {
      settled = true;
      return failures;
    });
    await flush();
    held.release.get(1)?.(new Error('first'));
    await flush();
    // A sequential loop's first throw would have ended the pass here; this one waits for the rest.
    expect(settled).toBe(false);
    held.release.get(2)?.();
    held.release.get(3)?.();
    expect((await done).map((f) => f.item)).toEqual([1]);
    expect(held.inFlight()).toBe(0);
  });
});
