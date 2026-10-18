/**
 * THE EPOCH OF AN ACCOUNT'S STORED FEED PAGES - the synchronous half of "a sign-out ends the copy".
 *
 * The feed's first pages are kept in the account's database, sealed under the device key
 * (`$lib/posts/feedStore`). Deleting them is asynchronous and needs that database open, which is the
 * wrong thing to do at a sign-out: a revoked-device wipe may be closing and deleting the same
 * database, and an open handle blocks the delete. So every stored page carries the EPOCH that was
 * current when it was written, and a page is drawn only when its epoch is still the account's. A
 * sign-out or a change of account erases every epoch HERE, synchronously, in the same call that
 * erases the community list (`stores/user.ts`): from that instant no stored page is drawable, and
 * the bytes are deleted the next time the account's store is read or written.
 *
 * An epoch is a random id, never a time: it answers "was this written since the last sign-out", and
 * nothing else.
 *
 * Kept free of any database import on purpose: `stores/user.ts` and `feedAudience.ts` call
 * {@link forgetStoredFeeds}, and neither should load the storage layer to do it.
 */

import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

/** Every account's epoch key starts so; enumerated by {@link forgetStoredFeeds}. */
const KEY_PREFIX = ACCOUNT_KEY.feedStoreEpoch('');

/** The key one account's epoch lives under. */
function keyFor(userId: string): string {
  return ACCOUNT_KEY.feedStoreEpoch(userId);
}

/**
 * The account's current epoch, or `null` when it has none (never written, or ended since by a
 * sign-out, a change of account or a refusal). A storage that refuses the read is logged and read as
 * no epoch, which draws nothing - the safe reading.
 */
export function currentFeedEpoch(userId: string): string | null {
  try {
    return localStorage.getItem(keyFor(userId));
  } catch (error) {
    console.warn(`[FEED-STORE] the feed epoch could not be read: ${String(error)}`);
    return null;
  }
}

/**
 * The account's current epoch, starting a new one when it has none.
 *
 * @returns the epoch and whether it was just started (the caller then deletes every older page), or
 * `null` when the storage refuses the write - logged, and the caller stores nothing.
 */
export function ensureFeedEpoch(userId: string): { epoch: string; started: boolean } | null {
  const existing = currentFeedEpoch(userId);
  if (existing) return { epoch: existing, started: false };
  const epoch = crypto.randomUUID();
  try {
    localStorage.setItem(keyFor(userId), epoch);
  } catch (error) {
    console.warn(
      `[FEED-STORE] could not start a feed epoch (${String(error)}) - the feed is not stored`
    );
    return null;
  }
  return { epoch, started: true };
}

/**
 * Ends EVERY account's stored feed pages, synchronously: no page written before this call is drawn
 * again. Called by a sign-out, a change of account, a refused feed answer (401/403) and an audience
 * verdict of `false`. The allowlist is this module's own key prefix: nothing else is touched.
 *
 * @param reason one word for the log line.
 * @returns how many epochs were ended.
 */
export function forgetStoredFeeds(reason: string): number {
  let keys: string[];
  try {
    keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(KEY_PREFIX)) keys.push(key);
    }
  } catch (error) {
    console.warn(`[FEED-STORE] could not list the feed epochs (${reason}): ${String(error)}`);
    return 0;
  }
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.warn(`[FEED-STORE] could not end the feed epoch ${key}: ${String(error)}`);
    }
  }
  if (keys.length > 0) {
    console.log(`[FEED-STORE] ${keys.length} stored feed epoch(s) ended (${reason})`);
  }
  return keys.length;
}
