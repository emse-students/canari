// @vitest-environment happy-dom
/**
 * SLOW-LINK CHANTIER, GAP 2: THE NOTIFICATIONS SCREEN DRAWS ITS LAST LIST WHILE THE NETWORK ANSWERS
 * NOTHING. The first paint with every read held unanswered: the rows are on screen, no spinner is
 * over them, and the list read that is still on the wire has not been waited for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { PostNotification } from '$lib/posts/api';
import { flushMacrotask } from '../../test/flush';

const sealed = vi.hoisted(() => ({ rows: new Map<string, unknown>() }));
const api = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('$lib/db', () => ({
  getStorage: async (userId: string) => ({
    saveFeedPage: async (key: string, payload: unknown) => {
      sealed.rows.set(`${userId}/${key}`, JSON.parse(JSON.stringify(payload)));
    },
    getFeedPage: async (key: string) => sealed.rows.get(`${userId}/${key}`) ?? null,
    deleteFeedPage: async (key: string) => (sealed.rows.delete(`${userId}/${key}`) ? 1 : 0),
  }),
}));
vi.mock('$lib/stores/user', () => ({ getSavedUserId: () => 'me' }));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getPostNotifications: api.list,
  markPostNotificationsRead: vi.fn(() => new Promise(() => {})),
}));
// Every other read of the page is on the wire and never answers.
vi.mock('$lib/proposals/api', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  countMyRepublicationRequests: () => new Promise(() => {}),
}));
vi.mock('$lib/follows/api', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  countFollowRequests: () => new Promise(() => {}),
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock(
  '$lib/components/notifications/NotificationRow.svelte',
  async () => import('../../test/stubs/NotificationRowStub.svelte')
);

import Page from './+page.svelte';
import { BELL_SLOT, bindLocalCopies } from '$lib/localCopies/localCopyStore.svelte';
import { postNotifStore } from '$lib/stores/postNotifStore.svelte';

const row = (id: string) =>
  ({
    id,
    read: true,
    postId: `post-${id}`,
    type: 'comment',
    createdAt: '2026-11-10T10:00:00Z',
    actorNames: [],
  }) as unknown as PostNotification;
const mounts = () => ((globalThis as Record<string, unknown>).__mounts ?? []) as string[];
const mounted: (() => void)[] = [];
const ME = { userId: 'me', deviceKeyB64: 'KEY' };

beforeEach(async () => {
  (globalThis as Record<string, unknown>).__mounts = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  localStorage.clear();
  sealed.rows.clear();
  api.list.mockReset();
  // A previous launch left a list sealed: answered once, then the memory went.
  bindLocalCopies(null);
  api.list.mockResolvedValueOnce([row('n1'), row('n2')]);
  bindLocalCopies(ME);
  await postNotifStore.load(50);
  await flushMacrotask();
  bindLocalCopies({ userId: 'other', deviceKeyB64: 'K2' });
  await flushMacrotask();
  bindLocalCopies(null);
  api.list.mockReset().mockReturnValue(new Promise(() => {}));
});
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('/notifications on a link that answers nothing', () => {
  it('draws the stored list once the key is in hand, with no spinner over it', async () => {
    expect(sealed.rows.has(`me/${BELL_SLOT}`)).toBe(true);
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(Page, { target });
    mounted.push(() => void unmount(app));
    await flushMacrotask();
    flushSync();
    // Locked until the key: nothing drawn from the device.
    expect(mounts()).toEqual([]);

    bindLocalCopies(ME);
    await flushMacrotask();
    flushSync();
    expect(mounts().join(' ')).toContain('n1');
    expect(mounts().join(' ')).toContain('n2');
    expect(postNotifStore.fromCopy).toBe(true);
    expect(target.querySelector('.animate-spin')).toBeNull();
  });
});
