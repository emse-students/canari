import { describe, expect, it, vi } from 'vitest';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { endMailOnSignOut, registerMailSignOut } from './mailSignOut';

/**
 * The Canari sign-out ends the mail session through the hook the mail client registers, and forgets
 * the leaving account's remembered password in every case - client or none (review I3).
 */

/** An in-memory Storage holding a sealed password for `userId`. */
function storeWithPassword(userId: string): Storage {
  const data = new Map<string, string>([[ACCOUNT_KEY.mailSealedPassword(userId), 'sealed']]);
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}

describe('endMailOnSignOut', () => {
  it('runs the registered sign-out, and nothing once unregistered', async () => {
    const signOut = vi.fn(async () => {});
    const unregister = registerMailSignOut(signOut);
    await endMailOnSignOut('signed out', null);
    expect(signOut).toHaveBeenCalledWith('signed out');
    unregister();
    await endMailOnSignOut('signed out', null);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('never throws: the Canari sign-out goes on whatever the mailbox answers', async () => {
    const unregister = registerMailSignOut(async () => {
      throw new Error('mailbox down');
    });
    await expect(endMailOnSignOut('signed out', null)).resolves.toBeUndefined();
    unregister();
  });

  it("an older client's unregister does not remove a newer one", async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const unregisterFirst = registerMailSignOut(first);
    const unregisterSecond = registerMailSignOut(second);
    unregisterFirst();
    await endMailOnSignOut('switch', null);
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    unregisterSecond();
  });

  it('forgets the leaving account password with NO mail client registered', async () => {
    const store = storeWithPassword('user-1');
    await endMailOnSignOut('signed out', 'user-1', store);
    expect(store.getItem(ACCOUNT_KEY.mailSealedPassword('user-1'))).toBeNull();
  });

  it('forgets the password FIRST, before the client signs out of the server (review M-4)', async () => {
    const store = storeWithPassword('user-1');
    let seenByClient: string | null = 'not called';
    const unregister = registerMailSignOut(async () => {
      seenByClient = store.getItem(ACCOUNT_KEY.mailSealedPassword('user-1'));
    });
    await endMailOnSignOut('signed out', 'user-1', store);
    expect(seenByClient).toBeNull();
    unregister();
  });

  it("forgets only the leaving account's password, after a failed client sign-out too", async () => {
    const store = storeWithPassword('user-1');
    store.setItem(ACCOUNT_KEY.mailSealedPassword('user-2'), 'other');
    const unregister = registerMailSignOut(async () => {
      throw new Error('mailbox down');
    });
    await endMailOnSignOut('signed out', 'user-1', store);
    expect(store.getItem(ACCOUNT_KEY.mailSealedPassword('user-1'))).toBeNull();
    expect(store.getItem(ACCOUNT_KEY.mailSealedPassword('user-2'))).toBe('other');
    unregister();
  });
});
