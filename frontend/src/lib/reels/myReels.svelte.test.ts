/**
 * The author's reels: the days are the server's, the list is asked once and again only when a reel
 * newer than it is drawn, and a failed read draws nothing as the member's.
 */
import { describe, expect, it, vi } from 'vitest';
import { MyReelsState } from './myReels.svelte';
import type { MyReel, MyReelsAnswer } from '$lib/posts/api';

const mine = (id: string, expiresAt: string): MyReel => ({
  id,
  createdAt: '2026-10-01T09:00:00Z',
  expiresAt,
  durationMs: 1000,
  expiringSoon: false,
  markdown: '',
  media: [],
});

const answer = (reels: MyReel[]): MyReelsAnswer => ({
  serverNow: '2026-10-02T09:00:00Z',
  warningWindowDays: 7,
  reels,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('MyReelsState', () => {
  it('asks once for every reel the list already speaks for', async () => {
    const fetch = vi.fn(async () => answer([mine('r1', '2026-10-31T09:00:00Z')]));
    const s = new MyReelsState(fetch);
    s.ensure({ id: 'r1', createdAt: '2026-10-01T09:00:00Z' });
    s.ensure({ id: 'r1', createdAt: '2026-10-01T09:00:00Z' });
    await flush();
    s.ensure({ id: 'someone-else', createdAt: '2026-09-30T09:00:00Z' });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(s.find('r1')?.id).toBe('r1');
    expect(s.find('someone-else')).toBeUndefined();
  });

  it('asks again for a reel created after the list it holds', async () => {
    const fetch = vi.fn(async () => answer([]));
    const s = new MyReelsState(fetch);
    s.ensure({ id: 'old', createdAt: '2026-10-01T09:00:00Z' });
    await flush();
    s.ensure({ id: 'new', createdAt: '2026-10-02T10:00:00Z' });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a list asked for another account speaks for nobody, and is asked again', async () => {
    let me = 'u1';
    const fetch = vi.fn(async () => answer([mine('r1', '2026-10-31T09:00:00Z')]));
    const s = new MyReelsState(fetch, () => me);
    s.ensure({ id: 'r1', createdAt: '2026-10-01T09:00:00Z' });
    await flush();
    expect(s.find('r1')?.id).toBe('r1');
    me = 'u2';
    expect(s.find('r1')).toBeUndefined();
    s.ensure({ id: 'r1', createdAt: '2026-10-01T09:00:00Z' });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a failed read draws nothing as the member own', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = new MyReelsState(vi.fn(async () => Promise.reject(new Error('offline'))));
    s.ensure({ id: 'r1', createdAt: '2026-10-01T09:00:00Z' });
    await flush();
    expect(s.find('r1')).toBeUndefined();
  });
});
