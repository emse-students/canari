import { describe, expect, it, vi } from 'vitest';
import type { PostEntity } from './api';
import { nextListPage } from './rankedFeeds';

const row = (id: string, ranked?: { asOf: string; position: number }) =>
  ({
    id,
    ...(ranked ? { feedAsOf: ranked.asOf, feedPosition: ranked.position } : {}),
  }) as PostEntity;

describe('nextListPage', () => {
  it('a ranked list asks after its last place served, of its own snapshot', () => {
    // Place 1 was withdrawn on the server: the count on screen (2) would ask it again.
    const rows = [row('a', { asOf: 'T', position: 0 }), row('c', { asOf: 'T', position: 2 })];
    expect(nextListPage(rows, rows.length)).toEqual({ offset: 3, asOf: 'T' });
  });

  it('a chronological list is paged by the count, as before', () => {
    expect(nextListPage([row('a'), row('b')], 2)).toEqual({ offset: 2 });
  });

  it('rows of two snapshots in one list are a defect, said aloud; the last snapshot is asked', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = [row('a', { asOf: 'T1', position: 5 }), row('b', { asOf: 'T2', position: 0 })];
    expect(nextListPage(rows, 2)).toEqual({ offset: 1, asOf: 'T2' });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
