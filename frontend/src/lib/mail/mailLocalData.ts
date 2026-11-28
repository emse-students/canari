import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { Log } from '$lib/utils/Log';
import { forgetNativeMailWatch } from './mailWatchCursor';

/**
 * WHAT THE MAIL CLIENT KEEPS ON THE DEVICE, AND THE ONE ERASURE THAT MAY TOUCH IT
 * (docs/wiki/mail-client.md D8).
 *
 * An account the school closed erases, on the device, the mail data and NOTHING ELSE: this is an
 * ALLOWLIST of the keys the erasure may remove, never a prefix or a pattern, so the erasure cannot
 * reach a key the mail client did not write. Lot 2 keeps the sealed password at rest; lot 4 adds the
 * new-mail watcher's cursor (an address and an item id, never a subject or a sender) and the
 * account's "Notifications de nouveaux mails" switch; lot 5 the device's subscription to the empty
 * mail push with the alert preferences it replaced, and Android's persistent-connection choice. The rest of the mail store lives in memory
 * (`MailStore.reset`). A later lot that persists mail (a cached list, a draft) adds its key HERE, and
 * `mailLocalData.test.ts` asserts the list is exactly what the module says.
 */

/** Every `localStorage` key of `userId` that holds mail data. */
export function mailLocalKeys(userId: string): string[] {
  return [
    ACCOUNT_KEY.mailSealedPassword(userId),
    ACCOUNT_KEY.mailWatchCursor(userId),
    ACCOUNT_KEY.mailNotifications(userId),
    ACCOUNT_KEY.mailAlert(userId),
    ACCOUNT_KEY.mailPersistentConnection(userId),
  ];
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
  // The apps keep the watcher's cursor in a native file (`mail_watch.rs`): erased with the rest.
  void forgetNativeMailWatch(userId);
  return removed;
}
