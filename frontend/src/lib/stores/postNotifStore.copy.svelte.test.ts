// @vitest-environment happy-dom
/**
 * SLOW-LINK CHANTIER, GAP 2: THE BELL DRAWS ITS LAST LIST WHILE THE NETWORK ANSWERS NOTHING.
 *
 * The number that closes the screen: first paint with every read unanswered. Here the list read
 * never settles, and the rows are on screen from the sealed copy with zero requests made for them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostNotification } from '$lib/posts/api';

const sealed = vi.hoisted(() => ({ rows: new Map<string, unknown>() }));
const api = vi.hoisted(() => ({
  get: vi.fn(),
  markAll: vi.fn(),
}));
const saved = vi.hoisted(() => ({ id: 'me' as string | null }));

vi.mock('$lib/db', () => ({
  // One database per account, as on a device.
  getStorage: async (userId: string) => ({
    saveFeedPage: async (key: string, payload: unknown) => {
      sealed.rows.set(`${userId}/${key}`, JSON.parse(JSON.stringify(payload)));
    },
    getFeedPage: async (key: string) => sealed.rows.get(`${userId}/${key}`) ?? null,
    deleteFeedPage: async (key: string) => (sealed.rows.delete(`${userId}/${key}`) ? 1 : 0),
  }),
}));
vi.mock('$lib/posts/api', () => ({
  getPostNotifications: api.get,
  markPostNotificationsRead: api.markAll,
  markPostNotificationsReadForPost: vi.fn(),
}));
vi.mock('$lib/stores/user', () => ({ getSavedUserId: () => saved.id }));

import { BELL_SLOT, bindLocalCopies } from '$lib/localCopies/localCopyStore.svelte';
import { endPeerNames } from '$lib/utils/users/peerNameDirectory';
import { MAX_STORED_NOTIFICATIONS, postNotifStore } from './postNotifStore.svelte';
import { TransportFailureError } from '$lib/utils/transportFailure';

const n = (id: string, read = false) => ({ id, read, postId: `p-${id}` }) as PostNotification;
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};
const ME = { userId: 'me', deviceKeyB64: 'KEY' };

/** Seals a list as a previous launch would have: answer, then a restart (memory emptied). */
async function sealOneList(rows: PostNotification[]) {
  api.get.mockResolvedValueOnce(rows);
  bindLocalCopies(ME);
  await postNotifStore.load(50);
  await settle();
}

describe('the bell, drawn from the device first', () => {
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.clear();
    sealed.rows.clear();
    api.get.mockReset();
    api.markAll.mockReset();
    saved.id = 'me';
    bindLocalCopies(null);
    endPeerNames('test');
    // Another account's bind empties whatever the previous test left in memory.
    bindLocalCopies({ userId: 'someone-else', deviceKeyB64: 'K' });
    await settle();
    bindLocalCopies(null);
  });

  it('seals the newest rows after an answer, and only that many', async () => {
    const many = Array.from({ length: MAX_STORED_NOTIFICATIONS + 10 }, (_, i) => n(`n${i}`));
    await sealOneList(many);
    const stored = (sealed.rows.get(`me/${BELL_SLOT}`) as { body: { items: unknown[] } }).body
      .items;
    expect(stored).toHaveLength(MAX_STORED_NOTIFICATIONS);
    expect(JSON.stringify({ ...localStorage })).not.toContain('n0');
  });

  it('draws the copy at once while the list read never answers, then the answer replaces it', async () => {
    await sealOneList([n('a'), n('b', true)]);
    // A restart: another account's bind empties memory, then this account opens with its key.
    bindLocalCopies({ userId: 'other', deviceKeyB64: 'K2' });
    await settle();
    expect(postNotifStore.notifications).toEqual([]);

    api.get.mockReset().mockReturnValue(new Promise(() => {})); // the link answers nothing
    bindLocalCopies(ME);
    await settle();
    expect(postNotifStore.notifications.map((x) => x.id)).toEqual(['a', 'b']);
    expect(postNotifStore.fromCopy).toBe(true);
    expect(api.get).not.toHaveBeenCalled(); // zero requests for this paint

    api.get.mockReset().mockResolvedValue([n('c')]);
    await postNotifStore.load(50);
    expect(postNotifStore.notifications.map((x) => x.id)).toEqual(['c']);
    expect(postNotifStore.fromCopy).toBe(false);
  });

  it('keeps the copy, and logs, when the revalidation fails', async () => {
    await sealOneList([n('a')]);
    bindLocalCopies({ userId: 'other', deviceKeyB64: 'K2' });
    await settle();
    bindLocalCopies(ME);
    await settle();
    expect(postNotifStore.fromCopy).toBe(true);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.get.mockRejectedValue(new Error('500'));
    await postNotifStore.load(50);
    expect(postNotifStore.notifications.map((x) => x.id)).toEqual(['a']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('the device copy'),
      expect.anything()
    );

    api.get.mockRejectedValue(new TransportFailureError('no link'));
    await postNotifStore.load(50);
    expect(postNotifStore.notifications.map((x) => x.id)).toEqual(['a']);
  });

  it('never draws or seals the list under another account', async () => {
    await sealOneList([n('mine')]);
    bindLocalCopies({ userId: 'other', deviceKeyB64: 'K2' });
    await settle();
    expect(postNotifStore.notifications).toEqual([]);
    expect(
      (sealed.rows.get(`me/${BELL_SLOT}`) as { owner: string }).owner // still mine, untouched
    ).toBe('me');
  });

  it('draws nothing while no key is in hand (a locked device)', async () => {
    await sealOneList([n('a')]);
    bindLocalCopies(null);
    bindLocalCopies({ userId: 'other', deviceKeyB64: 'K2' });
    await settle();
    bindLocalCopies(null);
    await settle();
    expect(postNotifStore.notifications).toEqual([]);
  });

  it('drops an answer that lands after an account switch, never drawing or sealing it for the next one', async () => {
    bindLocalCopies(ME);
    let answerA!: (rows: PostNotification[]) => void;
    api.get.mockReturnValueOnce(new Promise((resolve) => (answerA = resolve)));
    const poll = postNotifStore.load(50); // A's poll, in flight
    // Sign-out, sign-in as B on the same page (mobile: no reload).
    endPeerNames('sign-out');
    saved.id = 'bob';
    bindLocalCopies({ userId: 'bob', deviceKeyB64: 'KB' });
    await settle();
    answerA([n('secret-of-A')]);
    await poll;
    await settle();
    expect(postNotifStore.notifications).toEqual([]);
    expect(sealed.rows.has(`bob/${BELL_SLOT}`)).toBe(false);
    expect(sealed.rows.has(`me/${BELL_SLOT}`)).toBe(false);
  });

  it('empties the list at a sign-out, so the next account never meets it', async () => {
    await sealOneList([n('a')]);
    expect(postNotifStore.notifications).toHaveLength(1);
    endPeerNames('sign-out');
    expect(postNotifStore.notifications).toEqual([]);
  });

  it('seals only the full page, and only when it changed', async () => {
    bindLocalCopies(ME);
    await settle();
    api.get.mockResolvedValue([n('a')]);
    await postNotifStore.load(30); // the dropdown's page: not sealed
    await settle();
    expect(sealed.rows.has(`me/${BELL_SLOT}`)).toBe(false);
    await postNotifStore.load(50);
    await settle();
    const first = sealed.rows.get(`me/${BELL_SLOT}`);
    expect(first).toBeDefined();
    sealed.rows.delete(`me/${BELL_SLOT}`);
    await postNotifStore.load(50); // the 60 s poll, same list: nothing written
    await settle();
    expect(sealed.rows.has(`me/${BELL_SLOT}`)).toBe(false);
  });

  it('does not send the read receipt while the list is still the device copy', async () => {
    await sealOneList([n('a')]);
    bindLocalCopies({ userId: 'other', deviceKeyB64: 'K2' });
    await settle();
    bindLocalCopies(ME);
    await settle();
    expect(postNotifStore.fromCopy).toBe(true);
    await postNotifStore.markAllRead();
    expect(api.markAll).not.toHaveBeenCalled();
  });

  it('seals a read-all so the copy does not bring the badge back', async () => {
    await sealOneList([n('a'), n('b')]);
    api.markAll.mockResolvedValue(undefined);
    await postNotifStore.markAllRead();
    await settle();
    const items = (sealed.rows.get(`me/${BELL_SLOT}`) as { body: { items: { read: boolean }[] } })
      .body.items;
    expect(items.every((x) => x.read)).toBe(true);
  });
});
