import {
  FOR_YOU_CURSOR_PATTERN,
  FOR_YOU_LOWEST_ID,
  FOR_YOU_WINDOW_MAX,
  RANKED_SNAPSHOTS_KEPT,
  RANKED_SNAPSHOT_TTL_SECONDS,
  forYouCursorOf,
  forYouSlice,
  forYouSnapshotOf,
  parseForYouCursor,
  rankedSnapshotKey,
  readRankedSnapshot,
  writeRankedSnapshot,
  type ForYouRankedRow,
} from './for-you-feed';
import { fakeRankedRedis } from './ranked-snapshots.it-fixture';

const AS_OF = '2026-11-10T12:00:00.000000Z';
const START = '2026-10-27T12:00:00.000000Z';
const ID = '0f0e0d0c-0b0a-4000-8000-000000000001';

describe('for-you-feed paging (the pure half)', () => {
  it('a slice skips a withdrawn id without taking its position, and asks the tail only when short', () => {
    const served = new Set(['a', 'c', 'd']);
    const page = forYouSlice({ ids: ['a', 'b', 'c', 'd'], offset: 0, limit: 2, served });
    expect(page.picks).toEqual([
      { id: 'a', position: 0 },
      { id: 'c', position: 2 },
    ]);
    expect(page.tail).toBeNull();
    const next = forYouSlice({ ids: ['a', 'b', 'c', 'd'], offset: 3, limit: 3, served });
    expect(next).toEqual({ picks: [{ id: 'd', position: 3 }], tail: 2 });
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
    // An injected cap cuts at the same rule.
    expect(forYouSnapshotOf(AS_OF, START, rows, 1).tailBefore).toEqual({
      at: '2026-11-09T00:00:00.000000Z',
      id: 'b',
    });
  });

  it('a tail cursor is the placement and the id, and reads back as both', () => {
    const cursor = forYouCursorOf(AS_OF, ID);
    expect(cursor).toMatch(FOR_YOU_CURSOR_PATTERN);
    expect(parseForYouCursor(cursor)).toEqual({ at: AS_OF, id: ID });
    expect('2026-11-10T12:00:00Z_x').not.toMatch(FOR_YOU_CURSOR_PATTERN);
  });
});

describe('for-you-feed snapshots in Redis', () => {
  it('reads a snapshot back only for its own list, reader and instant, renewing the key by EXPIRE', async () => {
    const { redis, expiries, strings } = fakeRankedRedis();
    const snap = forYouSnapshotOf(AS_OF, START, []);
    await writeRankedSnapshot(redis, 'foryou:-', 'v', snap);
    expect(await readRankedSnapshot(redis, 'foryou:-', 'v', AS_OF)).toEqual(snap);
    expect(expiries).toEqual([
      { key: rankedSnapshotKey('foryou:-', 'v'), ttl: RANKED_SNAPSHOT_TTL_SECONDS },
      { key: rankedSnapshotKey('foryou:-', 'v'), ttl: RANKED_SNAPSHOT_TTL_SECONDS },
    ]);
    expect(strings.size).toBe(0); // never a SETEX rewrite
    expect(await readRankedSnapshot(redis, 'reels:reel', 'v', AS_OF)).toBeNull();
    expect(await readRankedSnapshot(redis, 'foryou:-', 'w', AS_OF)).toBeNull();
    expect(expiries).toHaveLength(2); // a miss renews nothing
  });

  it('keeps one key per list and reader, holding at most the newest snapshots', async () => {
    const { redis, hashes } = fakeRankedRedis();
    const instants = Array.from(
      { length: RANKED_SNAPSHOTS_KEPT + 2 },
      (_, i) => `2026-11-10T12:00:0${i}.000000Z`
    );
    for (const asOf of instants) {
      await writeRankedSnapshot(redis, 'foryou:-', 'v', forYouSnapshotOf(asOf, START, []));
    }
    expect(hashes.size).toBe(1);
    expect([...hashes.get(rankedSnapshotKey('foryou:-', 'v'))!.keys()].sort()).toEqual(
      instants.slice(-RANKED_SNAPSHOTS_KEPT)
    );
    expect(await readRankedSnapshot(redis, 'foryou:-', 'v', instants[0])).toBeNull();
  });

  it('a Redis that does not answer throws, on the read and on the write - never "gone"', async () => {
    const { redis, state } = fakeRankedRedis();
    state.failWrites = true;
    await expect(
      writeRankedSnapshot(redis, 'foryou:-', 'v', forYouSnapshotOf(AS_OF, START, []))
    ).rejects.toThrow('fake redis: write refused');
    state.failReads = true;
    await expect(readRankedSnapshot(redis, 'foryou:-', 'v', AS_OF)).rejects.toThrow(
      'fake redis: read refused'
    );
  });
});
