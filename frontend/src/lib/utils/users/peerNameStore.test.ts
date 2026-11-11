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

import { DIRECTORY_KEY, bindPeerNames, peerNamesSettled } from './peerNameStore';
import { endPeerNames, forgetPeerNames, notePeerName, readPeerName } from './peerNameDirectory';
import { forgetStoredFeeds, currentFeedEpoch } from '$lib/posts/feedStoreEpoch';

const flush = async () => {
  await peerNamesSettled();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('peerNameStore', () => {
  beforeEach(() => {
    localStorage.clear();
    sealed.rows.clear();
    sealed.keyUsed = [];
    sealed.failRead = false;
    bindPeerNames(null);
  });

  it('seals what is resolved under the device key, never in localStorage', async () => {
    bindPeerNames({ userId: 'me', deviceKeyB64: 'KEY' });
    await flush();
    notePeerName('me', 'peer-1', 'Alice Martin');
    await flush();
    expect(sealed.rows.has(DIRECTORY_KEY)).toBe(true);
    expect(sealed.keyUsed).toContain('KEY');
    expect(JSON.stringify({ ...localStorage })).not.toContain('Alice Martin');
  });

  it('names a peer from the device after a cold start, with no network', async () => {
    bindPeerNames({ userId: 'me', deviceKeyB64: 'KEY' });
    await flush();
    notePeerName('me', 'peer-1', 'Alice Martin');
    await flush();
    // Cold start: memory gone, the sealed row and the epoch remain.
    forgetPeerNames();
    bindPeerNames(null);
    expect(readPeerName('me', 'peer-1')).toBeNull(); // no key in hand: nothing drawn
    bindPeerNames({ userId: 'me', deviceKeyB64: 'KEY' });
    await flush();
    expect(readPeerName('me', 'peer-1')).toBe('Alice Martin');
  });

  it('keeps a name resolved before the key arrived and seals it at the bind', async () => {
    notePeerName('me', 'peer-2', 'Bob Durand');
    bindPeerNames({ userId: 'me', deviceKeyB64: 'KEY' });
    await flush();
    expect(readPeerName('me', 'peer-2')).toBe('Bob Durand');
    expect(
      (sealed.rows.get(DIRECTORY_KEY) as { names: Record<string, string> }).names['peer-2']
    ).toBe('Bob Durand');
  });

  it('does not read a copy once a sign-out ended its epoch, and deletes it', async () => {
    bindPeerNames({ userId: 'me', deviceKeyB64: 'KEY' });
    await flush();
    notePeerName('me', 'peer-1', 'Alice Martin');
    await flush();
    endPeerNames('sign-out');
    bindPeerNames(null);
    bindPeerNames({ userId: 'me', deviceKeyB64: 'KEY' });
    await flush();
    expect(readPeerName('me', 'peer-1')).toBeNull();
    expect(sealed.rows.has(DIRECTORY_KEY)).toBe(false);
  });

  it("never reads another account's copy", async () => {
    bindPeerNames({ userId: 'me', deviceKeyB64: 'KEY' });
    await flush();
    notePeerName('me', 'peer-1', 'Alice Martin');
    await flush();
    bindPeerNames({ userId: 'other', deviceKeyB64: 'KEY2' });
    await flush();
    expect(readPeerName('other', 'peer-1')).toBeNull();
    expect(readPeerName('me', 'peer-1')).toBeNull();
  });

  it('deletes a copy that cannot be opened instead of meeting it again', async () => {
    bindPeerNames({ userId: 'me', deviceKeyB64: 'KEY' });
    await flush();
    notePeerName('me', 'peer-1', 'Alice Martin');
    await flush();
    bindPeerNames(null);
    sealed.failRead = 'unreadable';
    bindPeerNames({ userId: 'me', deviceKeyB64: 'OTHER' });
    await flush();
    expect(sealed.rows.has(DIRECTORY_KEY)).toBe(false);
  });

  it('keeps the copy when the STORE failed, which says nothing about the row', async () => {
    bindPeerNames({ userId: 'me', deviceKeyB64: 'KEY' });
    await flush();
    notePeerName('me', 'peer-1', 'Alice Martin');
    await flush();
    bindPeerNames(null);
    sealed.failRead = 'store';
    bindPeerNames({ userId: 'me', deviceKeyB64: 'KEY' });
    await flush();
    expect(sealed.rows.has(DIRECTORY_KEY)).toBe(true);
  });

  it("does not ride the feed's epoch: ending the feed's copies leaves the names, and never starts a feed epoch", async () => {
    bindPeerNames({ userId: 'me', deviceKeyB64: 'KEY' });
    await flush();
    notePeerName('me', 'peer-1', 'Alice Martin');
    await flush();
    expect(currentFeedEpoch('me')).toBeNull();
    forgetStoredFeeds('outside the feed audience');
    bindPeerNames(null);
    bindPeerNames({ userId: 'me', deviceKeyB64: 'KEY' });
    await flush();
    expect(readPeerName('me', 'peer-1')).toBe('Alice Martin');
    expect(currentFeedEpoch('me')).toBeNull();
  });

  it('seals the in-memory names again under the NEW key after a PIN change', async () => {
    bindPeerNames({ userId: 'me', deviceKeyB64: 'OLD' });
    await flush();
    notePeerName('me', 'peer-1', 'Alice Martin');
    await flush();
    sealed.rows.delete(DIRECTORY_KEY); // dropStoredFeedPages, inside the PIN-change hold
    sealed.keyUsed = [];
    bindPeerNames({ userId: 'me', deviceKeyB64: 'NEW' });
    await flush();
    expect(sealed.keyUsed).toEqual(['NEW']);
    expect(
      (sealed.rows.get(DIRECTORY_KEY) as { names: Record<string, string> }).names['peer-1']
    ).toBe('Alice Martin');
  });
});
