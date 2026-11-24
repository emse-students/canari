// @vitest-environment happy-dom
/**
 * A CAMPUS TREND FOR A POST THIS DEVICE ALREADY DISPLAYED HAS NO BELL ROW (owner, 2026-11-24, "Verif
 * sur l'appareil"). The row is classified on its `type`; every other row is untouched; the withholding
 * is said once per row and never names the post; and the badge follows the list the reader sees.
 */
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
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
import { resetSeenPostsForTest, seenPostsStore } from '$lib/posts/seenPosts.svelte';

const row = (id: string, type: string, postId: string, read = false) =>
  ({ id, type, postId, read }) as PostNotification;
const PUBLISHED = new Date(1_800_000_000_000).toISOString();

describe('the bell withholds a campus trend for a post this device displayed', () => {
  let log: MockInstance<typeof console.log>;
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    saved.id = 'me';
    resetSeenPostsForTest();
    api.get.mockReset();
  });

  it('hides the trend row of a displayed post and keeps every other row', async () => {
    api.get.mockResolvedValue([
      row('r1', 'campus_trend', 'p1'),
      row('r2', 'campus_trend', 'p2'),
      row('r3', 'friend_comment', 'p1'),
    ]);
    await postNotifStore.load();
    expect(postNotifStore.notifications.map((n) => n.id)).toEqual(['r1', 'r2', 'r3']);

    seenPostsStore.note('p1', PUBLISHED);
    expect(postNotifStore.notifications.map((n) => n.id)).toEqual(['r2', 'r3']);
  });

  it('counts only the rows the reader sees in the badge', async () => {
    api.get.mockResolvedValue([row('r1', 'campus_trend', 'p1'), row('r2', 'campus_trend', 'p2')]);
    await postNotifStore.load();
    expect(postNotifStore.unread).toBe(2);
    seenPostsStore.note('p2', PUBLISHED);
    expect(postNotifStore.unread).toBe(1);
  });

  it('says each withheld row once, without the post id, however often the list is read', async () => {
    api.get.mockResolvedValue([row('r9', 'campus_trend', 'secret-post-id')]);
    seenPostsStore.note('secret-post-id', PUBLISHED);
    await postNotifStore.load();
    void postNotifStore.notifications;
    void postNotifStore.notifications;
    void postNotifStore.unread;
    const said = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[SEEN_TREND]'));
    expect(said).toHaveLength(1);
    expect(said[0]).not.toContain('secret-post-id');
  });

  it('never withholds under another account', async () => {
    seenPostsStore.note('p1', PUBLISHED);
    saved.id = 'someone-else';
    api.get.mockResolvedValue([row('r1', 'campus_trend', 'p1')]);
    await postNotifStore.load();
    expect(postNotifStore.notifications).toHaveLength(1);
  });
});
