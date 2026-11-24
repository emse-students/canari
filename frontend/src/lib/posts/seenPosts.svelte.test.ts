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

  it('flushes the pruned record to the sealed copy and to the native readers, once', async () => {
    bindLocalCopies({ userId: 'me', deviceKeyB64: 'K' });
    seenPostsStore.note('keep', fresh);
    seenPostsStore.note('old', ancient);
    await flushSeenPosts();
    const body = (sealed.rows.get(`me/${SEEN_POSTS_SLOT}`) as { body: { posts: object } }).body;
    expect(Object.keys(body.posts)).toEqual(['keep']);
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
    const [cmd, args] = tauri.invoke.mock.calls[0] as [
      string,
      { userId: string; posts: unknown[] },
    ];
    expect(cmd).toBe('store_seen_posts');
    expect(args.userId).toBe('me');
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
