// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** An in-memory stand-in for the account's sealed store: what `saveFeedPage` receives is what is returned. */
const sealed = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  keyUsed: [] as string[],
  failRead: false as false | 'unreadable' | 'store',
}));
import { FeedPageUnreadableError } from '$lib/db/types';

vi.mock('$lib/db', () => ({
  getStorage: async () => ({
    saveFeedPage: async (key: string, payload: unknown, deviceKey: string) => {
      sealed.keyUsed.push(deviceKey);
      sealed.rows.set(key, JSON.parse(JSON.stringify(payload)));
    },
    getFeedPage: async (key: string, deviceKey: string) => {
      sealed.keyUsed.push(deviceKey);
      if (sealed.failRead === 'unreadable') throw new FeedPageUnreadableError(key);
      if (sealed.failRead) throw new Error('database closing');
      return sealed.rows.get(key) ?? null;
    },
    deleteFeedPage: async (key: string) => (sealed.rows.delete(key) ? 1 : 0),
  }),
}));

import {
  BELL_SLOT,
  bindLocalCopies,
  localCopiesOpenFor,
  onLocalCopiesOpen,
  readLocalCopy,
  writeLocalCopy,
} from './localCopyStore.svelte';
import { endPeerNames } from '$lib/utils/users/peerNameDirectory';

const ME = { userId: 'me', deviceKeyB64: 'KEY' };
const asList = (body: unknown) => ((body as { items?: unknown[] })?.items ? (body as never) : null);

describe('localCopyStore', () => {
  beforeEach(() => {
    localStorage.clear();
    sealed.rows.clear();
    sealed.keyUsed = [];
    sealed.failRead = false;
    bindLocalCopies(null);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('seals under the device key and reads it back, never in localStorage', async () => {
    bindLocalCopies(ME);
    await writeLocalCopy(BELL_SLOT, { items: [{ id: 'secret-text-n1' }] });
    expect(sealed.keyUsed).toContain('KEY');
    expect(JSON.stringify({ ...localStorage })).not.toContain('secret-text-n1');
    expect(await readLocalCopy(ME, BELL_SLOT, asList)).toEqual({
      items: [{ id: 'secret-text-n1' }],
    });
  });

  it('reads and writes nothing while no key is in hand, and says so reactively', async () => {
    expect(localCopiesOpenFor()).toBeNull();
    await writeLocalCopy(BELL_SLOT, { items: [] });
    expect(sealed.rows.size).toBe(0);
    bindLocalCopies(ME);
    expect(localCopiesOpenFor()).toBe('me');
    bindLocalCopies(null);
    expect(localCopiesOpenFor()).toBeNull();
  });

  it('tells every registered store when copies open, and at once when already open', () => {
    const early = vi.fn();
    bindLocalCopies(ME);
    const off = onLocalCopiesOpen(early);
    expect(early).toHaveBeenCalledWith(ME);
    bindLocalCopies({ userId: 'me', deviceKeyB64: 'NEW' });
    expect(early).toHaveBeenCalledTimes(2);
    bindLocalCopies({ userId: 'me', deviceKeyB64: 'NEW' }); // unchanged: no call
    expect(early).toHaveBeenCalledTimes(2);
    off();
  });

  it('does not read a copy once a sign-out ended the epoch, and deletes it', async () => {
    bindLocalCopies(ME);
    await writeLocalCopy(BELL_SLOT, { items: [{ id: 'n1' }] });
    endPeerNames('sign-out');
    expect(await readLocalCopy(ME, BELL_SLOT, asList)).toBeNull();
    expect(sealed.rows.has(BELL_SLOT)).toBe(false);
  });

  it("never reads another account's copy", async () => {
    bindLocalCopies(ME);
    await writeLocalCopy(BELL_SLOT, { items: [{ id: 'n1' }] });
    const other = { userId: 'other', deviceKeyB64: 'KEY2' };
    bindLocalCopies(other);
    expect(await readLocalCopy(other, BELL_SLOT, asList)).toBeNull();
    expect(sealed.rows.has(BELL_SLOT)).toBe(false);
  });

  it('deletes a slot that cannot be opened, and a body of another shape', async () => {
    bindLocalCopies(ME);
    await writeLocalCopy(BELL_SLOT, { items: [] });
    sealed.failRead = 'unreadable';
    expect(await readLocalCopy(ME, BELL_SLOT, asList)).toBeNull();
    expect(sealed.rows.has(BELL_SLOT)).toBe(false);

    sealed.failRead = false;
    await writeLocalCopy(BELL_SLOT, { other: true });
    expect(await readLocalCopy(ME, BELL_SLOT, asList)).toBeNull();
    expect(sealed.rows.has(BELL_SLOT)).toBe(false);
  });

  it('keeps the slot when the STORE failed, which says nothing about the row', async () => {
    bindLocalCopies(ME);
    await writeLocalCopy(BELL_SLOT, { items: [] });
    sealed.failRead = 'store';
    expect(await readLocalCopy(ME, BELL_SLOT, asList)).toBeNull();
    expect(sealed.rows.has(BELL_SLOT)).toBe(true);
  });
});
