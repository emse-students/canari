/**
 * `getStorage` HANDS BACK ONE OPEN STORE PER USER, AND NEVER A CLOSED ONE.
 *
 * `init()` is not a cheap read: it opens the database and replays PRAGMA plus every CREATE TABLE
 * and CREATE INDEX. A cold Android launch called `getStorage` twice - once for the conversations
 * panel, once from the login flow - and paid that sequence twice, the second time ON THE PATH TO
 * THE BIOMETRIC PROMPT, which is the delay this cache exists to remove (Pixel 6a, 2026-09-15).
 *
 * A cache of handles is only safe while it can tell a live handle from a dead one. `close()` is
 * reachable from the revoked-device wipe, and a cache blind to it would answer the NEXT caller with
 * a store whose connection is gone - every call on it failing for a reason the caller could not
 * name. So the three facts pinned here are the three the cache can get wrong.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => true }));

/** Opens counted across the suite, so "did it open again?" is answerable rather than inferred. */
let opens = 0;
/** Set to make the NEXT open fail, the way a full disk does. */
let failNextOpen = false;

vi.mock('./sqlite', () => ({
  SqliteStorage: class {
    db: object | null = null;
    get isOpen(): boolean {
      return this.db !== null;
    }
    async init(): Promise<void> {
      opens++;
      if (failNextOpen) {
        failNextOpen = false;
        throw new Error('database or disk is full');
      }
      this.db = {};
    }
    async close(): Promise<void> {
      this.db = null;
    }
  },
}));

describe('getStorage shares one open handle per user', () => {
  beforeEach(() => {
    opens = 0;
    failNextOpen = false;
    vi.resetModules();
  });

  it('opens once for repeated calls, and once more per distinct user', async () => {
    const { getStorage } = await import('../db');

    const first = await getStorage('alice');
    const second = await getStorage('alice');

    expect(second).toBe(first);
    expect(opens).toBe(1);

    await getStorage('bob');
    expect(opens).toBe(2);
  });

  it('joins a single open when two callers race a cold start', async () => {
    const { getStorage } = await import('../db');

    const [a, b] = await Promise.all([getStorage('alice'), getStorage('alice')]);

    expect(b).toBe(a);
    expect(opens).toBe(1);
  });

  it('never hands back a handle the wipe has closed', async () => {
    const { getStorage } = await import('../db');

    const closed = await getStorage('alice');
    await closed.close();

    const reopened = await getStorage('alice');

    expect(reopened).not.toBe(closed);
    expect(reopened.isOpen).toBe(true);
    expect(opens).toBe(2);
  });

  it('does not remember a failed open as one', async () => {
    const { getStorage } = await import('../db');

    failNextOpen = true;
    await expect(getStorage('alice')).rejects.toThrow('disk is full');

    // A transient failure must not become permanent for the rest of the session.
    const recovered = await getStorage('alice');
    expect(recovered.isOpen).toBe(true);
    expect(opens).toBe(2);
  });
});
