// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** An in-memory stand-in for the account's sealed store: what `saveFeedPage` receives is what is returned. */
const sealed = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  keyUsed: [] as string[],
  failRead: false,
}));
vi.mock('$lib/db', () => ({
  getStorage: async () => ({
    saveFeedPage: async (key: string, payload: unknown, deviceKey: string) => {
      sealed.keyUsed.push(deviceKey);
      sealed.rows.set(key, JSON.parse(JSON.stringify(payload)));
    },
    getFeedPage: async (key: string, deviceKey: string) => {
      sealed.keyUsed.push(deviceKey);
      if (sealed.failRead) throw new Error('cannot open');
      return sealed.rows.get(key) ?? null;
    },
    deleteFeedPage: async (key: string) => (sealed.rows.delete(key) ? 1 : 0),
  }),
}));

import { DIRECTORY_KEY, bindPeerNames, peerNamesSettled } from './peerNameStore';
import { forgetPeerNames, notePeerName, readPeerName } from './peerNameDirectory';
import { forgetStoredFeeds } from '$lib/posts/feedStoreEpoch';

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

  it('does not read a copy once a sign-out ended the feed epoch, and deletes it', async () => {
    bindPeerNames({ userId: 'me', deviceKeyB64: 'KEY' });
    await flush();
    notePeerName('me', 'peer-1', 'Alice Martin');
    await flush();
    forgetStoredFeeds('sign-out');
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
    sealed.failRead = true;
    bindPeerNames({ userId: 'me', deviceKeyB64: 'OTHER' });
    await flush();
    expect(sealed.rows.has(DIRECTORY_KEY)).toBe(false);
  });
});
