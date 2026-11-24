// @vitest-environment happy-dom
/**
 * A CAMPUS TREND FOR A POST THIS DEVICE ALREADY DISPLAYED HAS NO BELL ROW (owner, 2026-11-24, "Verif
 * sur l'appareil"). The row is classified on its `type`; every other row is untouched; the withholding
 * is said once per row and never names the post; and the badge follows the list the reader sees.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { PostNotification } from '$lib/posts/api';

const api = vi.hoisted(() => ({ get: vi.fn() }));
const saved = vi.hoisted(() => ({ id: 'me' as string | null }));

vi.mock('$lib/db', () => ({
  getStorage: async () => ({
    saveFeedPage: async () => {},
    getFeedPage: async () => null,
    deleteFeedPage: async () => 0,
  }),
}));
vi.mock('$lib/posts/api', () => ({
  getPostNotifications: api.get,
  markPostNotificationsRead: vi.fn(),
  markPostNotificationsReadForPost: vi.fn(),
}));
vi.mock('$lib/stores/user', () => ({ getSavedUserId: () => saved.id }));

import { postNotifStore } from './postNotifStore.svelte';
import { flushSeenPosts, resetSeenPostsForTest, seenPostsStore } from '$lib/posts/seenPosts.svelte';

const row = (id: string, type: string, postId: string, read = false) =>
  ({ id, type, postId, read, createdAt: new Date().toISOString() }) as PostNotification;
const PUBLISHED = new Date().toISOString();
const HOURS = 3_600_000;

describe('the bell withholds a campus trend for a post this device displayed', () => {
  let log: MockInstance<typeof console.log>;
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    saved.id = 'me';
    resetSeenPostsForTest();
    api.get.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('hides the trend row of a displayed post and keeps every other row', async () => {
    api.get.mockResolvedValue([
      row('r1', 'campus_trend', 'p1'),
      row('r2', 'campus_trend', 'p2'),
      row('r3', 'friend_comment', 'p1'),
    ]);
    seenPostsStore.note('p1', PUBLISHED);
    await postNotifStore.load();
    expect(postNotifStore.notifications.map((n) => n.id)).toEqual(['r2', 'r3']);
  });

  it('never makes a trend row vanish that the reader already saw in the bell (L1)', async () => {
    api.get.mockResolvedValue([row('r1', 'campus_trend', 'p1')]);
    await postNotifStore.load();
    expect(postNotifStore.notifications).toHaveLength(1);
    // The post is displayed AFTER its row appeared (the row, or its push, was shown): kept for good,
    // however many answers follow.
    seenPostsStore.note('p1', PUBLISHED);
    await postNotifStore.load();
    await postNotifStore.load(100);
    expect(postNotifStore.notifications).toHaveLength(1);
    expect(postNotifStore.unread).toBe(1);
  });

  it('counts only the rows the reader sees in the badge', async () => {
    api.get.mockResolvedValue([row('r1', 'campus_trend', 'p1'), row('r2', 'campus_trend', 'p2')]);
    seenPostsStore.note('p2', PUBLISHED);
    await postNotifStore.load();
    expect(postNotifStore.unread).toBe(1);
  });

  it('says a decision once, without the post id, however often the list is read', async () => {
    api.get.mockResolvedValue([row('r9', 'campus_trend', 'secret-post-id')]);
    seenPostsStore.note('secret-post-id', PUBLISHED);
    await postNotifStore.load();
    await postNotifStore.load();
    void postNotifStore.notifications;
    void postNotifStore.unread;
    const said = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('withheld'));
    expect(said).toHaveLength(1);
    expect(said[0]).not.toContain('secret-post-id');
  });

  it('keeps a withheld row withheld after the record has aged out (B2)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    seenPostsStore.note('p1', PUBLISHED);
    api.get.mockResolvedValue([row('r1', 'campus_trend', 'p1')]);
    await postNotifStore.load();
    expect(postNotifStore.notifications).toHaveLength(0);
    // Three days on, a complete answer: the 25 h record is aged out, the 90-day row is still listed.
    vi.setSystemTime(Date.now() + 72 * HOURS);
    await postNotifStore.load();
    await flushSeenPosts();
    expect(seenPostsStore.size).toBe(0);
    expect(postNotifStore.notifications).toHaveLength(0);
    expect(postNotifStore.unread).toBe(0);
  });

  it('ages the record out per post from a full page that reaches back before it (60 rows, 50 answered)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    seenPostsStore.note('p1', PUBLISHED);
    const base = Date.now();
    // 60 rows in 90 days, newest first: the bell answers 50, never a short page.
    const rows = Array.from({ length: 50 }, (_, i) => ({
      ...row(`r${i}`, i === 0 ? 'campus_trend' : 'friend_comment', 'p1'),
      createdAt: new Date(base - i * 24 * HOURS).toISOString(),
    }));
    api.get.mockResolvedValue(rows);
    await postNotifStore.load(50);
    expect(seenPostsStore.size).toBe(1);
    // Three days on, the page again: its oldest row is older than the post, the window is closed.
    vi.setSystemTime(base + 72 * HOURS);
    await postNotifStore.load(50);
    expect(seenPostsStore.size).toBe(0);
    // The withheld trend row stays out.
    expect(postNotifStore.notifications.some((n) => n.id === 'r0')).toBe(false);
  });

  it('never withholds under another account', async () => {
    seenPostsStore.note('p1', PUBLISHED);
    saved.id = 'someone-else';
    api.get.mockResolvedValue([row('r1', 'campus_trend', 'p1')]);
    await postNotifStore.load();
    expect(postNotifStore.notifications).toHaveLength(1);
  });
});
