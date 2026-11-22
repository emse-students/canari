import { mapWithConcurrency } from './map-with-concurrency';

describe('mapWithConcurrency', () => {
  it('never has more than `limit` calls in flight, and keeps input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return n * 2;
    });
    expect(peak).toBe(3);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  });

  it('propagates a rejection and starts no further work after it', async () => {
    const seen: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 1, async (n) => {
        seen.push(n);
        if (n === 2) throw new Error('boom');
        return n;
      })
    ).rejects.toThrow('boom');
    expect(seen).toEqual([1, 2]);
  });

  it('handles an empty list', async () => {
    await expect(mapWithConcurrency([], 6, async (n: number) => n)).resolves.toEqual([]);
  });
});
