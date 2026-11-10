import { describe, expect, it, vi } from 'vitest';
import type { PostEntity } from './api';
import {
  mergeListPage,
  nextListPage,
  readNextPage,
  RANKING_GONE,
  type ListPage,
} from './rankedFeeds';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { Log } from '$lib/utils/Log';

const row = (id: string, ranked?: { asOf: string; position: number; cursor?: string }) =>
  ({
    id,
    ...(ranked
      ? {
          feedAsOf: ranked.asOf,
          feedPosition: ranked.position,
          ...(ranked.cursor ? { feedCursor: ranked.cursor } : {}),
        }
      : {}),
  }) as PostEntity;
const ids = (rows: readonly PostEntity[]) => rows.map((r) => r.id);

describe('nextListPage', () => {
  it('a ranked list asks after its last place served, of its own snapshot, in the ranked shape', () => {
    // Place 1 was withdrawn on the server: the count on screen (2) would ask it again.
    const rows = [row('a', { asOf: 'T', position: 0 }), row('c', { asOf: 'T', position: 2 })];
    expect(nextListPage(rows, rows.length)).toEqual({ offset: 3, asOf: 'T', rankedFeeds: true });
  });

  it('below the window, the last tail row is the cursor', () => {
    const rows = [row('a', { asOf: 'T', position: 4, cursor: 'C4' })];
    expect(nextListPage(rows, 1)).toEqual({
      offset: 5,
      asOf: 'T',
      cursor: 'C4',
      rankedFeeds: true,
    });
  });

  it('a list served without ranking facts keeps that older shape; an empty one follows the estate', () => {
    expect(nextListPage([row('a'), row('b')], 2)).toEqual({ offset: 2, rankedFeeds: false });
    expect(nextListPage([], 0)).toEqual({ offset: 0 });
  });

  it('after a new ranking, the newest snapshot is paged', () => {
    const rows = [row('a', { asOf: 'T1', position: 5 }), row('b', { asOf: 'T2', position: 0 })];
    expect(nextListPage(rows, 2)).toEqual({ offset: 1, asOf: 'T2', rankedFeeds: true });
  });
});

describe('mergeListPage', () => {
  it('appends the new rows only; a row on screen keeps its place and takes its new ranking facts', () => {
    const shown = [row('a', { asOf: 'T1', position: 0 }), row('b', { asOf: 'T1', position: 1 })];
    const page = [row('b', { asOf: 'T2', position: 3 }), row('c', { asOf: 'T2', position: 4 })];
    const merged = mergeListPage(shown, page);
    expect(ids(merged.rows)).toEqual(['a', 'b', 'c']);
    expect(ids(merged.appended)).toEqual(['c']);
    expect(merged.rows[1]).toMatchObject({ feedAsOf: 'T2', feedPosition: 3 });
  });

  it('a chronological duplicate is dropped, the row on screen untouched', () => {
    const a = row('a');
    const merged = mergeListPage([a], [row('a'), row('b')]);
    expect(merged.rows[0]).toBe(a);
    expect(ids(merged.appended)).toEqual(['b']);
  });
});

describe('readNextPage', () => {
  const gone = () => new ApiRefusalError(410, RANKING_GONE, 'gone');

  it('reads one page after the last place and appends it', async () => {
    const read = vi.fn((_p: ListPage & { limit: number }) =>
      Promise.resolve([row('c', { asOf: 'T', position: 2 }), row('d', { asOf: 'T', position: 3 })])
    );
    const shown = [row('a', { asOf: 'T', position: 0 }), row('b', { asOf: 'T', position: 1 })];
    const next = await readNextPage({ shown, limit: 2, read });
    expect(read).toHaveBeenCalledWith({ offset: 2, asOf: 'T', rankedFeeds: true, limit: 2 });
    expect(ids(next.rows)).toEqual(['a', 'b', 'c', 'd']);
    expect(next.ended).toBe(false);
  });

  it('a ranking that is gone (410) is ranked anew, only the rows not on screen appended, said as a warning', async () => {
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => {});
    const shown = [row('a', { asOf: 'T1', position: 0 }), row('b', { asOf: 'T1', position: 1 })];
    const read = vi
      .fn((_p: ListPage & { limit: number }) => Promise.resolve([] as PostEntity[]))
      .mockRejectedValueOnce(gone())
      .mockResolvedValueOnce([
        row('b', { asOf: 'T2', position: 0 }),
        row('x', { asOf: 'T2', position: 1 }),
        row('a', { asOf: 'T2', position: 2 }),
      ]);
    const next = await readNextPage({ shown, limit: 3, read });
    expect(read).toHaveBeenNthCalledWith(2, { offset: 0, rankedFeeds: true, limit: 3 });
    expect(ids(next.rows)).toEqual(['a', 'b', 'x']);
    expect(ids(next.appended)).toEqual(['x']);
    // The rows on screen now carry the new ranking's places: the next page starts after 2.
    expect(nextListPage(next.rows, 3)).toEqual({ offset: 3, asOf: 'T2', rankedFeeds: true });
    // Short of a page with the list not ended: reading on was asked of the new ranking.
    expect(read).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenLastCalledWith({ offset: 3, asOf: 'T2', rankedFeeds: true, limit: 3 });
    expect(warn).toHaveBeenCalledWith('RANKED', expect.stringContaining('is gone'));
    warn.mockRestore();
  });

  it('ranks anew at most once per read: a second 410 is thrown to the caller', async () => {
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => {});
    const shown = [row('a', { asOf: 'T1', position: 0 })];
    const read = vi
      .fn((_p: ListPage & { limit: number }) => Promise.resolve([] as PostEntity[]))
      .mockRejectedValueOnce(gone())
      // The re-rank's page is full but holds a post on screen, so the next page of it is read -
      // and that ranking is already gone too.
      .mockResolvedValueOnce([
        row('a', { asOf: 'T2', position: 0 }),
        row('x', { asOf: 'T2', position: 1 }),
      ])
      .mockRejectedValueOnce(gone());
    await expect(readNextPage({ shown, limit: 2, read })).rejects.toMatchObject({ status: 410 });
    expect(read).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it('every other refusal is thrown to the caller: a 503 is not read as the end', async () => {
    const read = vi.fn(() => Promise.reject(new ApiRefusalError(503, 'RANKING_UNAVAILABLE', 'x')));
    await expect(
      readNextPage({ shown: [row('a', { asOf: 'T', position: 0 })], limit: 2, read })
    ).rejects.toMatchObject({ status: 503 });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a page that moves the list no further ends it rather than asking it again', async () => {
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => {});
    const shown = [row('a', { asOf: 'T', position: 5 }), row('b', { asOf: 'T', position: 6 })];
    // A server that serves places already passed: nothing new, no place after the one asked.
    const read = vi.fn(() =>
      Promise.resolve([row('a', { asOf: 'T', position: 5 }), row('b', { asOf: 'T', position: 6 })])
    );
    const next = await readNextPage({ shown, limit: 2, read });
    expect(read).toHaveBeenCalledTimes(1);
    expect(next.ended).toBe(true);
    warn.mockRestore();
  });

  it('a chronological list reads one page, whatever it held', async () => {
    const read = vi.fn(() => Promise.resolve([row('a'), row('b')]));
    const next = await readNextPage({ shown: [row('a')], limit: 2, read });
    expect(read).toHaveBeenCalledWith({ offset: 1, rankedFeeds: false, limit: 2 });
    expect(ids(next.appended)).toEqual(['b']);
  });
});
