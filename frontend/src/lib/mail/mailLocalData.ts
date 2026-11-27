import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { Log } from '$lib/utils/Log';

/**
 * WHAT THE MAIL CLIENT KEEPS ON THE DEVICE, AND THE ONE ERASURE THAT MAY TOUCH IT
 * (docs/wiki/mail-client.md D8).
 *
 * An account the school closed erases, on the device, the mail data and NOTHING ELSE: this is an
 * ALLOWLIST of the keys the erasure may remove, never a prefix or a pattern, so the erasure cannot
 * reach a key the mail client did not write. Lot 2 keeps one thing at rest - the sealed password -
 * and the rest of the mail store lives in memory (`MailStore.reset`). A later lot that persists mail
 * (a cached list, a draft) adds its key HERE, and `mailLocalData.test.ts` asserts the list is exactly
 * what the module says.
 */

/** Every `localStorage` key of `userId` that holds mail data. */
export function mailLocalKeys(userId: string): string[] {
  return [ACCOUNT_KEY.mailSealedPassword(userId)];
}

/**
 * Removes {@link mailLocalKeys} of `userId` from `store`, and only those. Returns the keys that were
 * there and are now gone (for the caller's log and its test).
 */
export function eraseMailLocalData(userId: string, store: Storage = localStorage): string[] {
  const removed: string[] = [];
  for (const key of mailLocalKeys(userId)) {
    if (store.getItem(key) === null) continue;
    store.removeItem(key);
    removed.push(key);
  }
  Log.i('MAIL', `the mailbox is closed: ${removed.length} mail entries erased on this device`);
  return removed;
}
