import {
  FOR_YOU_LOWEST_ID,
  FOR_YOU_WINDOW_MAX,
  forYouSlice,
  forYouSnapshotOf,
  readRankedSnapshot,
  writeRankedSnapshot,
  type ForYouRankedRow,
} from './for-you-feed';
import type { RedisService } from '../common/redis/redis.service';

const AS_OF = '2026-11-10T12:00:00.000000Z';
const START = '2026-10-27T12:00:00.000000Z';

describe('for-you-feed paging (the pure half)', () => {
  it('a slice skips a withdrawn id without taking its position, and asks the tail only when short', () => {
    const served = new Map([
      ['a', 'A'],
      ['c', 'C'],
      ['d', 'D'],
    ]);
    const page = forYouSlice({ ids: ['a', 'b', 'c', 'd'], offset: 0, limit: 2, served });
    expect(page.rows).toEqual([
      { row: 'A', position: 0 },
      { row: 'C', position: 2 },
    ]);
    expect(page.tail).toBeNull();
    const next = forYouSlice({ ids: ['a', 'b', 'c', 'd'], offset: 3, limit: 3, served });
    expect(next.rows).toEqual([{ row: 'D', position: 3 }]);
    expect(next.tail).toEqual({ offset: 0, limit: 2 });
    const deep = forYouSlice({ ids: ['a', 'b', 'c', 'd'], offset: 6, limit: 3, served });
    expect(deep).toEqual({ rows: [], tail: { offset: 2, limit: 3 } });
  });

  it('the tail starts below the window, or below its oldest row when the window was full', () => {
    const rows: ForYouRankedRow[] = [
      { id: 'b', at: '2026-11-09T00:00:00.000000Z', suggested: false },
      { id: 's', at: '2026-11-08T00:00:00.000000Z', suggested: true },
    ];
    expect(forYouSnapshotOf(AS_OF, START, rows)).toEqual({
      asOf: AS_OF,
      ids: ['b', 's'],
      suggested: ['s'],
      tailBefore: { at: START, id: FOR_YOU_LOWEST_ID },
    });
    const full: ForYouRankedRow[] = Array.from({ length: FOR_YOU_WINDOW_MAX }, (_, i) => ({
      id: `id${String(i).padStart(3, '0')}`,
      at: `2026-11-${String(10 - (i % 3)).padStart(2, '0')}T00:00:00.000000Z`,
      suggested: false,
    }));
    // The oldest instant is the 8th; among its rows, the smallest id.
    expect(forYouSnapshotOf(AS_OF, START, full).tailBefore).toEqual({
      at: '2026-11-08T00:00:00.000000Z',
      id: 'id002',
    });
  });

  it('a snapshot is read back only for its own list, reader and instant, and its lifetime renewed', async () => {
    const store = new Map<string, string>();
    const setex = jest.fn((k: string, _t: number, v: string) => {
      store.set(k, v);
      return Promise.resolve();
    });
    const redis = {
      get: (k: string) => Promise.resolve(store.get(k) ?? null),
      setex,
    } as unknown as RedisService;
    const snap = forYouSnapshotOf(AS_OF, START, []);
    await writeRankedSnapshot(redis, 'foryou', 'v', snap);
    expect(await readRankedSnapshot(redis, 'foryou', 'v', AS_OF)).toEqual(snap);
    expect(setex).toHaveBeenCalledTimes(2);
    expect(await readRankedSnapshot(redis, 'reels', 'v', AS_OF)).toBeNull();
    expect(await readRankedSnapshot(redis, 'foryou', 'w', AS_OF)).toBeNull();
  });
});
