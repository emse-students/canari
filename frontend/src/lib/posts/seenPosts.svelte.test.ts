// @vitest-environment happy-dom
/**
 * The store behind the seen-trend rule: what a displayed card records, where it is kept, and what
 * erases it (owner, 2026-11-24).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sealed = vi.hoisted(() => ({ rows: new Map<string, unknown>() }));
const saved = vi.hoisted(() => ({ id: 'me' as string | null }));
const tauri = vi.hoisted(() => ({ invoke: vi.fn(), mobile: true }));

vi.mock('$lib/db', () => ({
  getStorage: async (userId: string) => ({
    saveFeedPage: async (key: string, payload: unknown) => {
      sealed.rows.set(`${userId}/${key}`, JSON.parse(JSON.stringify(payload)));
    },
    getFeedPage: async (key: string) => sealed.rows.get(`${userId}/${key}`) ?? null,
    deleteFeedPage: async (key: string) => (sealed.rows.delete(`${userId}/${key}`) ? 1 : 0),
  }),
}));
vi.mock('$lib/stores/user', () => ({ getSavedUserId: () => saved.id }));
vi.mock('$lib/utils/appVersion', () => ({ isMobileTauriRuntime: () => tauri.mobile }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import { SEEN_POSTS_SLOT, bindLocalCopies } from '$lib/localCopies/localCopyStore.svelte';
import { endPeerNames } from '$lib/utils/users/peerNameDirectory';
import {
  flushSeenPosts,
  forgetSeenPosts,
  resetSeenPostsForTest,
  seenPostsStore,
} from './seenPosts.svelte';

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};
const NOW = Date.now();
const HOUR = 3_600_000;
const fresh = new Date(NOW - 3_600_000).toISOString();
const ancient = new Date(NOW - 5 * 24 * 3_600_000).toISOString();

describe('the record of the posts this device displayed', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sealed.rows.clear();
    tauri.invoke.mockReset().mockResolvedValue(1);
    tauri.mobile = true;
    saved.id = 'me';
    bindLocalCopies(null);
    endPeerNames('test');
    resetSeenPostsForTest();
  });

  it('records a displayed post and classifies a trend row against it', () => {
    seenPostsStore.note('p1', fresh);
    expect(seenPostsStore.isSeenTrend({ type: 'campus_trend' }, 'p1')).toBe(true);
    expect(seenPostsStore.isSeenTrend({ type: 'campus_trend' }, 'p2')).toBe(false);
    expect(seenPostsStore.isSeenTrend({ type: 'friend_comment' }, 'p1')).toBe(false);
  });

  it('records nothing for a post without a publication instant, or with nobody signed in', () => {
    seenPostsStore.note('p1', null);
    saved.id = null;
    seenPostsStore.note('p2', fresh);
    expect(seenPostsStore.size).toBe(0);
  });

  it("is one account's: another account never reads it", () => {
    seenPostsStore.note('p1', fresh);
    saved.id = 'someone-else';
    expect(seenPostsStore.isSeenTrend({ type: 'campus_trend' }, 'p1')).toBe(false);
    seenPostsStore.note('p9', fresh);
    expect(seenPostsStore.size).toBe(1);
    saved.id = 'me';
    expect(seenPostsStore.isSeenTrend({ type: 'campus_trend' }, 'p1')).toBe(false);
  });

  it('seals the record and hands the native readers only what is inside the window, once', async () => {
    bindLocalCopies({ userId: 'me', deviceKeyB64: 'K' });
    seenPostsStore.note('keep', fresh);
    seenPostsStore.note('old', ancient);
    await flushSeenPosts();
    const body = (sealed.rows.get(`me/${SEEN_POSTS_SLOT}`) as { body: { posts: object } }).body;
    // No bell answer listed every row yet: the in-memory record is not aged out (B2).
    expect(Object.keys(body.posts).sort()).toEqual(['keep', 'old']);
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
    const [cmd, args] = tauri.invoke.mock.calls[0] as [
      string,
      { userId: string; posts: unknown[] },
    ];
    expect(cmd).toBe('store_seen_posts');
    expect(args.userId).toBe('me');
    // The native file prunes by age, always: a push reads it.
    expect(args.posts).toEqual([{ postId: 'keep', publishedAt: Date.parse(fresh) }]);
    // Nothing new: nothing written.
    await flushSeenPosts();
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
  });

  it('writes the native copy as soon as a post is noted - no visibility change, no timer (B1)', async () => {
    bindLocalCopies({ userId: 'me', deviceKeyB64: 'K' });
    seenPostsStore.note('a', fresh);
    seenPostsStore.note('b', fresh);
    await settle();
    // Both notes of the same tick share one write, native file first.
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
    expect(tauri.invoke.mock.calls[0][0]).toBe('store_seen_posts');
    expect(
      (tauri.invoke.mock.calls[0][1] as { posts: unknown[] }).posts.map(
        (p) => (p as { postId: string }).postId
      )
    ).toEqual(['a', 'b']);
    expect(sealed.rows.has(`me/${SEEN_POSTS_SLOT}`)).toBe(true);
    // A later note writes again (the record is dirty again), with nothing else needed.
    seenPostsStore.note('c', fresh);
    await settle();
    expect(tauri.invoke).toHaveBeenCalledTimes(2);
  });

  it('writes no native copy off mobile', async () => {
    tauri.mobile = false;
    seenPostsStore.note('p1', fresh);
    await flushSeenPosts();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it('keeps the record for the next write when the native copy failed', async () => {
    tauri.invoke.mockRejectedValueOnce(new Error('disk'));
    seenPostsStore.note('p1', fresh);
    await flushSeenPosts();
    await flushSeenPosts();
    expect(tauri.invoke).toHaveBeenCalledTimes(2);
  });

  it('draws the sealed copy back after a restart', async () => {
    bindLocalCopies({ userId: 'me', deviceKeyB64: 'K' });
    seenPostsStore.note('keep', fresh);
    await flushSeenPosts();
    // A restart: memory empties, the account opens again with its key.
    bindLocalCopies(null);
    resetSeenPostsForTest();
    bindLocalCopies({ userId: 'me', deviceKeyB64: 'K' });
    await settle();
    expect(seenPostsStore.isSeenTrend({ type: 'campus_trend' }, 'keep')).toBe(true);
  });

  it('still withholds a row met after the app stayed closed through the whole window (B2)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      bindLocalCopies({ userId: 'me', deviceKeyB64: 'K' });
      seenPostsStore.note('keep', new Date(Date.now() - HOUR).toISOString());
      await flushSeenPosts();
      // The app closes; 30 hours later it reopens - the trend row only appears now.
      bindLocalCopies(null);
      resetSeenPostsForTest();
      vi.setSystemTime(Date.now() + 30 * HOUR);
      bindLocalCopies({ userId: 'me', deviceKeyB64: 'K' });
      await settle();
      expect(seenPostsStore.size).toBe(1);
      const trend = { id: 'r1', type: 'campus_trend', postId: 'keep' };
      seenPostsStore.decideRows([trend], true);
      expect(seenPostsStore.withholdsRow(trend)).toBe(true);
      // A bell answer listing every row has now been taken: the record may age out, the row stays.
      expect(seenPostsStore.size).toBe(0);
      expect(seenPostsStore.withholdsRow(trend)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('decides a trend row ONCE, when it first appears: withheld if its post is in the record, kept if not', () => {
    seenPostsStore.note('seen-first', fresh);
    const a = { id: 'a', type: 'campus_trend', postId: 'seen-first' };
    const b = { id: 'b', type: 'campus_trend', postId: 'later' };
    seenPostsStore.decideRows([a, b], false);
    expect(seenPostsStore.withholdsRow(a)).toBe(true);
    expect(seenPostsStore.withholdsRow(b)).toBe(false);
    // Displayed afterwards: the kept row stays (L1); the withheld one stays withheld.
    seenPostsStore.note('later', fresh);
    seenPostsStore.decideRows([a, b], true);
    expect(seenPostsStore.withholdsRow(b)).toBe(false);
    expect(seenPostsStore.withholdsRow(a)).toBe(true);
  });

  it('keeps both decisions in the sealed copy and drops them with their row (90 days)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      bindLocalCopies({ userId: 'me', deviceKeyB64: 'K' });
      seenPostsStore.note('p', fresh);
      const created = new Date().toISOString();
      const a = { id: 'a', type: 'campus_trend', postId: 'p', createdAt: created };
      const b = { id: 'b', type: 'campus_trend', postId: 'q', createdAt: created };
      seenPostsStore.decideRows([a, b], false);
      await flushSeenPosts();
      type Sealed = { body: { withheld: object; kept: object } };
      const stored = (sealed.rows.get(`me/${SEEN_POSTS_SLOT}`) as Sealed).body;
      expect(Object.keys(stored.withheld)).toEqual(['a']);
      expect(Object.keys(stored.kept)).toEqual(['b']);
      // The rows are gone from the server after their 90 days: so are the decisions.
      vi.setSystemTime(Date.now() + 100 * 24 * HOUR);
      seenPostsStore.decideRows([], false);
      await flushSeenPosts();
      const later = (sealed.rows.get(`me/${SEEN_POSTS_SLOT}`) as Sealed).body;
      expect(Object.keys(later.withheld)).toEqual([]);
      expect(Object.keys(later.kept)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is erased at sign-out: memory now, and the native copy of the account', async () => {
    seenPostsStore.note('p1', fresh);
    await forgetSeenPosts('ME');
    expect(seenPostsStore.size).toBe(0);
    expect(tauri.invoke).toHaveBeenCalledWith('forget_seen_posts', { userId: 'me' });
  });

  it('is erased when the account changes (the peer-names epoch ends)', () => {
    seenPostsStore.note('p1', fresh);
    endPeerNames('sign-out');
    expect(seenPostsStore.size).toBe(0);
  });
});
